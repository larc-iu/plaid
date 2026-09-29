import { describe, it, expect, vi, afterEach } from 'vitest';
import { CommentStore } from './CommentStore.js';

// A comment post whose answer was lost (V5, H5-1): posted again it was stored
// twice. And a Comments tab opened after comments were made elsewhere (H7-4).

const ME = 'me@example.com';
let seq = 0;
const row = (over = {}) => ({
  id: `c${++seq}`,
  projectId: 'p1',
  documentId: 'd1',
  entityType: 'token',
  entityId: 't1',
  authorId: ME,
  body: 'text',
  createdAt: `2026-09-29T00:00:${String(seq).padStart(2, '0')}.000Z`,
  edited: false,
  ...over,
});

// A server whose `create` stores the comment and then loses the answer when
// told to.
const fakeClient = () => {
  const state = { rows: [], loseNext: null };
  return {
    state,
    comments: {
      list: vi.fn(async (_p, f = {}) =>
        state.rows.filter(
          (r) =>
            (!f.documentId || r.documentId === f.documentId) &&
            (!f.entityType || r.entityType === f.entityType) &&
            (!f.entityId || r.entityId === f.entityId),
        ),
      ),
      create: vi.fn(async (entityType, entityId, body) => {
        const lose = state.loseNext;
        state.loseNext = null;
        if (lose?.stored !== false) {
          state.rows.push(row({ entityType, entityId, body }));
        }
        if (lose) throw lose.error();
        return state.rows.at(-1);
      }),
    },
    users: { get: vi.fn(async (id) => ({ id, displayName: id })) },
    messages: { listen: vi.fn(() => ({ readyState: 1, close: () => {} })) },
  };
};

const lost = (status) => () =>
  Object.assign(new Error(status ? `HTTP ${status} Unable to read error response` : 'timed out'), {
    status,
    method: 'POST',
    url: 'http://x/api/v1/comments',
  });

const open = (client) => {
  const store = new CommentStore({ client, projectId: 'p1', documentId: 'd1', currentUserId: ME });
  const errors = [];
  store.onError = (msg, err) => errors.push(err);
  return { store, errors };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('a post whose answer was lost', () => {
  for (const status of [0, 502]) {
    it(`keeps the comment when it was stored (status ${status}), so it is not posted twice`, async () => {
      const client = fakeClient();
      const { store, errors } = open(client);
      await store.load();
      client.state.loseNext = { error: lost(status) };
      const posted = await store.post('token', 't1', 'Is this right?');
      expect(posted?.body).toBe('Is this right?');
      expect(errors).toEqual([]);
      expect(store.threadFor('t1').map((c) => c.body)).toEqual(['Is this right?']);
      expect(client.state.rows).toHaveLength(1);
    });
  }

  it('does not take an earlier comment with the same words for it', async () => {
    const client = fakeClient();
    client.state.rows.push(row({ body: 'Is this right?' }));
    const { store, errors } = open(client);
    await store.load();
    client.state.loseNext = { error: lost(0), stored: false };
    expect(await store.post('token', 't1', 'Is this right?')).toBe(null);
    expect(errors).toHaveLength(1);
  });

  it('is put back when it was not stored, and shows once it lands late', async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    const { store, errors } = open(client);
    await store.load();
    client.state.loseNext = { error: lost(0), stored: false };
    expect(await store.post('token', 't1', 'Late')).toBe(null);
    expect(errors).toHaveLength(1);
    expect(store.threadFor('t1')).toEqual([]);
    client.state.rows.push(row({ body: 'Late' }));
    await vi.advanceTimersByTimeAsync(30000);
    expect(store.threadFor('t1').map((c) => c.body)).toEqual(['Late']);
  });

  it('is not looked for after a refusal, whose outcome is known', async () => {
    const client = fakeClient();
    const { store } = open(client);
    await store.load();
    const reads = client.comments.list.mock.calls.length;
    client.state.loseNext = {
      stored: false,
      error: () => Object.assign(new Error('HTTP 400 bad'), { status: 400, method: 'POST' }),
    };
    expect(await store.post('token', 't1', 'x')).toBe(null);
    expect(client.comments.list.mock.calls.length).toBe(reads);
  });
});

describe('opening the live stream', () => {
  it('reads in what was said while no stream was open', async () => {
    const client = fakeClient();
    const { store } = open(client);
    await store.load();
    client.state.rows.push(row({ authorId: 'them@example.com', body: 'LIVECHECK1' }));
    const release = store.watchLive();
    await vi.waitFor(() => expect(store.count).toBe(1));
    release();
  });
});
