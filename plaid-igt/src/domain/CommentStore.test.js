import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommentStore, normalizeCommentEvent, isPending } from './CommentStore.js';

const PROJECT = 'p1';
const DOC = 'd1';
const ME = 'me@example.com';
const THEM = 'them@example.com';

let seq = 0;
const comment = (over = {}) => {
  const n = ++seq;
  const at = over.createdAt ?? `2026-08-31T00:00:${String(n).padStart(2, '0')}.000Z`;
  return {
    id: over.id ?? `c${n}`,
    projectId: PROJECT,
    documentId: DOC,
    entityType: 'token',
    entityId: 't1',
    authorId: ME,
    body: `comment ${n}`,
    createdAt: at,
    updatedAt: at,
    edited: false,
    ...over,
  };
};

// A stand-in for client.comments. `list` answers from `rows`, honoring the
// same filters the server does, so the store is exercised against the real
// call shape rather than a bespoke one.
const fakeClient = (rows = []) => {
  const state = { rows: [...rows] };
  return {
    state,
    comments: {
      list: vi.fn(async (_projectId, filters = {}) =>
        state.rows.filter(
          (r) =>
            (!filters.documentId || r.documentId === filters.documentId) &&
            (!filters.entityType || r.entityType === filters.entityType) &&
            (!filters.entityId || r.entityId === filters.entityId),
        ),
      ),
      create: vi.fn(async (entityType, entityId, body) =>
        comment({ id: `srv${++seq}`, entityType, entityId, body, authorId: ME }),
      ),
      update: vi.fn(async (id, body) => ({
        ...state.rows.find((r) => r.id === id),
        body,
        edited: true,
      })),
      delete: vi.fn(async () => undefined),
    },
    users: {
      get: vi.fn(async (id) => ({ id, displayName: `Name of ${id}`, isAdmin: false })),
    },
  };
};

const makeStore = (client, over = {}) =>
  new CommentStore({
    client,
    projectId: PROJECT,
    documentId: DOC,
    currentUserId: ME,
    ...over,
  });

beforeEach(() => {
  seq = 0;
});

describe('normalizeCommentEvent', () => {
  it('camelCases the kebab-cased SSE payload', () => {
    // The asymmetry this exists to absorb: message payloads are opaque and are
    // NOT key-transformed by plaid-client, unlike every REST response.
    expect(
      normalizeCommentEvent({
        type: 'comment',
        action: 'created',
        'comment-id': 'c1',
        'document-id': DOC,
        'entity-type': 'span',
        'entity-id': 's1',
        'author-id': THEM,
      }),
    ).toEqual({
      action: 'created',
      commentId: 'c1',
      documentId: DOC,
      entityType: 'span',
      entityId: 's1',
      authorId: THEM,
    });
  });

  it('ignores anything that is not a comment event', () => {
    expect(normalizeCommentEvent({ type: 'service_response' })).toBeNull();
    expect(normalizeCommentEvent(null)).toBeNull();
  });
});

describe('CommentStore reads', () => {
  it('groups a document load by entity, oldest first', async () => {
    const client = fakeClient([
      comment({ id: 'b', entityId: 't1', createdAt: '2026-08-31T00:00:02.000Z' }),
      comment({ id: 'a', entityId: 't1', createdAt: '2026-08-31T00:00:01.000Z' }),
      comment({ id: 'c', entityId: 's9', entityType: 'span' }),
    ]);
    const store = makeStore(client);
    await store.load();

    expect(store.isLoaded).toBe(true);
    expect(client.comments.list).toHaveBeenCalledWith(PROJECT, { documentId: DOC });
    expect(store.threadFor('t1').map((c) => c.id)).toEqual(['a', 'b']);
    expect(store.countFor('t1')).toBe(2);
    expect(store.countFor('s9')).toBe(1);
    expect(store.countFor('nothing-here')).toBe(0);
  });

  it('reports threads with their entity type, ordered by first comment', async () => {
    const client = fakeClient([
      comment({ id: 'late', entityId: 'z', createdAt: '2026-08-31T00:00:09.000Z' }),
      comment({
        id: 'early',
        entityId: 'a',
        entityType: 'span',
        createdAt: '2026-08-31T00:00:01.000Z',
      }),
    ]);
    const store = makeStore(client);
    await store.load();

    expect(store.threads().map((t) => [t.entityId, t.entityType])).toEqual([
      ['a', 'span'],
      ['z', 'token'],
    ]);
  });

  it('surfaces a load failure without throwing', async () => {
    const client = fakeClient();
    client.comments.list.mockRejectedValueOnce(new Error('boom'));
    const store = makeStore(client);
    const onError = vi.fn();
    store.onError = onError;

    await store.load();

    expect(store.isLoaded).toBe(false);
    expect(store.error).toMatch(/Failed to load comments/);
    expect(onError).toHaveBeenCalled();
  });

  it('allows editing only your own comment', async () => {
    const client = fakeClient([
      comment({ id: 'mine', authorId: ME }),
      comment({ id: 'theirs', authorId: THEM }),
    ]);
    const store = makeStore(client);
    await store.load();

    expect(store.canEdit(store.threadFor('t1').find((c) => c.id === 'mine'))).toBe(true);
    expect(store.canEdit(store.threadFor('t1').find((c) => c.id === 'theirs'))).toBe(false);
  });
});

describe('CommentStore writes', () => {
  it('shows a posted comment before the server answers, then swaps in the real row', async () => {
    const client = fakeClient();
    const store = makeStore(client);
    await store.load();

    let resolve;
    client.comments.create.mockImplementationOnce(
      () => new Promise((r) => (resolve = () => r(comment({ id: 'srv1', body: 'hello' })))),
    );

    const posting = store.post('token', 't1', 'hello');
    // Optimistic: visible immediately, flagged as not yet acknowledged.
    expect(store.countFor('t1')).toBe(1);
    expect(isPending(store.threadFor('t1')[0])).toBe(true);
    expect(store.canEdit(store.threadFor('t1')[0])).toBe(false);

    resolve();
    await posting;

    expect(store.countFor('t1')).toBe(1);
    expect(store.threadFor('t1')[0].id).toBe('srv1');
    expect(isPending(store.threadFor('t1')[0])).toBe(false);
  });

  it('rolls the optimistic comment back when the post fails', async () => {
    const client = fakeClient();
    client.comments.create.mockRejectedValueOnce(new Error('403'));
    const store = makeStore(client);
    await store.load();
    const onError = vi.fn();
    store.onError = onError;

    const result = await store.post('token', 't1', 'hello');

    expect(result).toBeNull();
    expect(store.countFor('t1')).toBe(0);
    expect(store.error).toMatch(/Failed to post comment/);
    expect(onError).toHaveBeenCalled();
  });

  it('refuses to post an empty or whitespace-only body without calling the server', async () => {
    const client = fakeClient();
    const store = makeStore(client);
    await store.load();

    expect(await store.post('token', 't1', '   \n ')).toBeNull();
    expect(await store.post('token', 't1', '')).toBeNull();
    expect(client.comments.create).not.toHaveBeenCalled();
  });

  it('edits optimistically and restores the old body on failure', async () => {
    const client = fakeClient([comment({ id: 'c1', body: 'before' })]);
    const store = makeStore(client);
    await store.load();

    client.comments.update.mockRejectedValueOnce(new Error('nope'));
    const ok = await store.edit('c1', 'after');

    expect(ok).toBe(false);
    expect(store.threadFor('t1')[0].body).toBe('before');
    expect(store.threadFor('t1')[0].edited).toBe(false);
    expect(store.error).toMatch(/Failed to edit comment/);
  });

  it('marks an edited comment and keeps the server response', async () => {
    const client = fakeClient([comment({ id: 'c1', body: 'before' })]);
    const store = makeStore(client);
    await store.load();

    expect(await store.edit('c1', 'after')).toBe(true);
    expect(store.threadFor('t1')[0].body).toBe('after');
    expect(store.threadFor('t1')[0].edited).toBe(true);
  });

  it('puts a deleted comment back when the delete fails', async () => {
    const client = fakeClient([
      comment({ id: 'a', createdAt: '2026-08-31T00:00:01.000Z' }),
      comment({ id: 'b', createdAt: '2026-08-31T00:00:02.000Z' }),
    ]);
    const store = makeStore(client);
    await store.load();

    client.comments.delete.mockRejectedValueOnce(new Error('offline'));
    const ok = await store.remove('a');

    expect(ok).toBe(false);
    // Back in its original position, not appended to the end.
    expect(store.threadFor('t1').map((c) => c.id)).toEqual(['a', 'b']);
    expect(store.error).toMatch(/Failed to delete comment/);
  });

  it('drops the entity from the index when its last comment goes', async () => {
    const client = fakeClient([comment({ id: 'only' })]);
    const store = makeStore(client);
    await store.load();

    expect(await store.remove('only')).toBe(true);
    expect(store.countFor('t1')).toBe(0);
    expect(store.threads()).toEqual([]);
  });
});

describe('CommentStore live updates', () => {
  it('re-reads the named thread on someone else s event', async () => {
    const client = fakeClient([comment({ id: 'a', entityId: 't1' })]);
    const store = makeStore(client);
    await store.load();
    expect(store.countFor('t1')).toBe(1);

    client.state.rows.push(comment({ id: 'b', entityId: 't1', authorId: THEM }));
    const applied = await store.applyEvent({
      type: 'comment',
      action: 'created',
      'comment-id': 'b',
      'document-id': DOC,
      'entity-type': 'token',
      'entity-id': 't1',
      'author-id': THEM,
    });

    expect(applied).toBe(true);
    expect(store.threadFor('t1').map((c) => c.id)).toEqual(['a', 'b']);
    // Scoped to the one thread, not the whole document.
    expect(client.comments.list).toHaveBeenLastCalledWith(PROJECT, {
      entityType: 'token',
      entityId: 't1',
    });
  });

  it('reflects a remote delete', async () => {
    const client = fakeClient([
      comment({ id: 'a', entityId: 't1' }),
      comment({ id: 'b', entityId: 't1', authorId: THEM }),
    ]);
    const store = makeStore(client);
    await store.load();

    client.state.rows = client.state.rows.filter((r) => r.id !== 'b');
    await store.applyEvent({
      type: 'comment',
      action: 'deleted',
      'comment-id': 'b',
      'document-id': DOC,
      'entity-type': 'token',
      'entity-id': 't1',
      'author-id': THEM,
    });

    expect(store.threadFor('t1').map((c) => c.id)).toEqual(['a']);
  });

  it('ignores the echo of our own write', async () => {
    const client = fakeClient();
    const store = makeStore(client);
    await store.load();
    client.comments.list.mockClear();

    const applied = await store.applyEvent({
      type: 'comment',
      action: 'created',
      'comment-id': 'c1',
      'document-id': DOC,
      'entity-type': 'token',
      'entity-id': 't1',
      'author-id': ME,
    });

    expect(applied).toBe(false);
    expect(client.comments.list).not.toHaveBeenCalled();
  });

  it('ignores events for another document', async () => {
    const client = fakeClient();
    const store = makeStore(client);
    await store.load();
    client.comments.list.mockClear();

    expect(
      await store.applyEvent({
        type: 'comment',
        action: 'created',
        'document-id': 'some-other-doc',
        'entity-type': 'token',
        'entity-id': 't1',
        'author-id': THEM,
      }),
    ).toBe(false);
    expect(client.comments.list).not.toHaveBeenCalled();
  });

  it('does not surface an error when a live refresh fails', async () => {
    const client = fakeClient();
    const store = makeStore(client);
    await store.load();
    const onError = vi.fn();
    store.onError = onError;
    client.comments.list.mockRejectedValueOnce(new Error('flaky'));

    // A dropped live update is repaired by the next one; a toast would be noise.
    expect(
      await store.applyEvent({
        type: 'comment',
        action: 'created',
        'document-id': DOC,
        'entity-type': 'token',
        'entity-id': 't1',
        'author-id': THEM,
      }),
    ).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(store.error).toBe('');
  });
});

describe('CommentStore author names', () => {
  it('resolves each distinct author once and falls back to the id on failure', async () => {
    const client = fakeClient([
      comment({ id: 'a', authorId: ME }),
      comment({ id: 'b', authorId: ME }),
      comment({ id: 'c', authorId: THEM }),
    ]);
    client.users.get.mockImplementation(async (id) => {
      if (id === THEM) throw new Error('gone');
      return { id, displayName: 'Me, Myself' };
    });
    const store = makeStore(client);

    await store.load();
    // Names are cosmetic, so load() does not block on them.
    expect(store.isLoaded).toBe(true);
    await store.whenAuthorsResolved();

    expect(store.authorName(ME)).toBe('Me, Myself');
    expect(store.authorName(THEM)).toBe(THEM);
    // Two authors, two requests, despite three comments.
    expect(client.users.get).toHaveBeenCalledTimes(2);
  });

  it('does not re-request a name it already has', async () => {
    const client = fakeClient([comment({ id: 'a', authorId: ME })]);
    const store = makeStore(client);
    await store.load();
    await store.whenAuthorsResolved();
    client.users.get.mockClear();

    await store.load();
    await store.whenAuthorsResolved();
    expect(client.users.get).not.toHaveBeenCalled();
  });

  it('resolves a name for an author first seen through a live update', async () => {
    const client = fakeClient([comment({ id: 'a', authorId: ME })]);
    const store = makeStore(client);
    await store.load();
    await store.whenAuthorsResolved();

    client.state.rows.push(comment({ id: 'b', entityId: 't1', authorId: THEM }));
    await store.applyEvent({
      type: 'comment',
      action: 'created',
      'document-id': DOC,
      'entity-type': 'token',
      'entity-id': 't1',
      'author-id': THEM,
    });
    await store.whenAuthorsResolved();

    expect(store.authorName(THEM)).toBe(`Name of ${THEM}`);
  });
});

describe('CommentStore subscription', () => {
  it('notifies listeners on every change and unsubscribes cleanly', async () => {
    const client = fakeClient();
    const store = makeStore(client);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    await store.load();
    const afterLoad = listener.mock.calls.length;
    expect(afterLoad).toBeGreaterThan(0);
    expect(store.getSnapshot()).toBeGreaterThan(0);

    await store.post('token', 't1', 'hi');
    expect(listener.mock.calls.length).toBeGreaterThan(afterLoad);

    unsubscribe();
    const afterUnsub = listener.mock.calls.length;
    await store.post('token', 't1', 'again');
    expect(listener.mock.calls.length).toBe(afterUnsub);
  });
});
