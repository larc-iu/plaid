import { describe, it, expect, vi, afterEach } from 'vitest';
import { CommentStore } from './CommentStore.js';

// A comment post whose answer was lost (V5, H5-1): posted again it was stored
// twice. A post names the id of the comment it makes, and the client sends a
// write whose answer was lost again under the same key, so it lands once.
// When even that gives up, posting the same words again names the same id,
// and a post that had landed is answered 409 `id-taken` and kept. And a
// Comments tab opened after comments were made elsewhere (H7-4).

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

// A server whose `create` stores the comment under the id it names, refuses
// an id used before with 409 `id-taken`, and loses the answer when told to.
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
      get: vi.fn(async (id) => state.rows.find((r) => r.id === id)),
      create: vi.fn(async (entityType, entityId, body, { id } = {}) => {
        if (state.rows.some((r) => r.id === id)) {
          throw Object.assign(new Error('HTTP 409 id-taken'), {
            status: 409,
            method: 'POST',
            responseData: { error: 'id-taken', 'id-taken': true, id },
          });
        }
        const lose = state.loseNext;
        state.loseNext = null;
        if (lose?.stored !== false) {
          state.rows.push(row({ id, entityType, entityId, body }));
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
    it(`(status ${status}) posted again names the same id, and the one stored is kept`, async () => {
      const client = fakeClient();
      const { store, errors } = open(client);
      await store.load();
      client.state.loseNext = { error: lost(status) };
      // The thread cannot be read either, so the post is not confirmed.
      const list = client.comments.list;
      client.comments.list = async () => Promise.reject(lost(status)());
      expect(await store.post('token', 't1', 'Is this right?')).toBe(null);
      client.comments.list = list;
      expect(errors).toHaveLength(1);
      const posted = await store.post('token', 't1', 'Is this right?');
      expect(posted?.body).toBe('Is this right?');
      const ids = client.comments.create.mock.calls.map((c) => c[3].id);
      expect(ids[0]).toBe(ids[1]);
      expect(store.threadFor('t1').map((c) => c.body)).toEqual(['Is this right?']);
      expect(client.state.rows).toHaveLength(1);
    });
  }

  // REV-idempotency F5: taken off the screen as failed while the server had it.
  it('is kept when the thread read after the lost answer holds it', async () => {
    const client = fakeClient();
    const { store, errors } = open(client);
    await store.load();
    client.state.loseNext = { error: lost(502) };
    const posted = await store.post('token', 't1', 'Is this a loan word?');
    expect(posted?.body).toBe('Is this a loan word?');
    expect(errors).toEqual([]);
    expect(store.threadFor('t1').map((c) => c.body)).toEqual(['Is this a loan word?']);
    expect(client.state.rows).toHaveLength(1);
  });

  it('posted again after it was not stored, it is stored once', async () => {
    const client = fakeClient();
    const { store } = open(client);
    await store.load();
    client.state.loseNext = { error: lost(0), stored: false };
    expect(await store.post('token', 't1', 'Late')).toBe(null);
    expect(store.threadFor('t1')).toEqual([]);
    expect((await store.post('token', 't1', 'Late'))?.body).toBe('Late');
    expect(client.state.rows).toHaveLength(1);
  });

  it('other words are another comment, under another id', async () => {
    const client = fakeClient();
    const { store } = open(client);
    await store.load();
    client.state.loseNext = { error: lost(0), stored: false };
    await store.post('token', 't1', 'One');
    await store.post('token', 't1', 'Two');
    const ids = client.comments.create.mock.calls.map((c) => c[3].id);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('is not read again after a refusal, whose outcome is known', async () => {
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
