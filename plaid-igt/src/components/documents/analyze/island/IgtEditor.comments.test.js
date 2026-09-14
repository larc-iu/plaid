import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';
import { CommentStore } from '@ui/domain/CommentStore';

// Deleting a comment from the grid's popover. A comment is unaudited, so there
// is no history entry and no restore: the delete is asked for first, the same
// way the entry panel asks, and a mount that cannot ask does not delete.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

const ME = 'me@example.com';

let host;
let editor;

const seededStore = () => {
  const store = new CommentStore({ client: {}, documentId: 'doc-1', currentUserId: ME });
  const comment = {
    id: 'c-1',
    entityType: 'token',
    entityId: 'w-1',
    authorId: ME,
    body: 'check this word',
    createdAt: '2026-09-01T00:00:00.000Z',
  };
  store._loaded = true;
  store._byId.set(comment.id, comment);
  store._byEntity.set('w-1', [comment]);
  store._authors.set(ME, 'Me');
  store.remove = vi.fn(async () => {});
  return store;
};

const mount = (opts = {}) => {
  resetIds();
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw: buildRawDoc({}),
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: [], writers: [] },
    vocabularies: {},
    client,
    projectId: 'proj-1',
    user: null,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, { canComment: true, ...opts });
  return doc;
};

const openThread = () => {
  // The badge on the word that carries the comment, not the first on screen:
  // an empty sentence badge offers a composer and nothing to delete.
  const badge = host.querySelector('[data-pop-opener="comment:w-1"]');
  expect(badge).not.toBeNull();
  badge.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(host.querySelector('.igt-cmt-pop')).not.toBeNull();
  return host.querySelector('[aria-label="Delete this comment"]');
};

beforeEach(() => {
  host = null;
  editor = null;
});
afterEach(() => {
  editor?.destroy();
  host?.remove();
});

describe('deleting a comment from the grid', () => {
  it('asks first, and keeps the comment when the answer is no', async () => {
    const store = seededStore();
    const confirmDeleteComment = vi.fn(async () => false);
    mount({ comments: store, confirmDeleteComment });

    openThread().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(confirmDeleteComment).toHaveBeenCalledWith(expect.objectContaining({ id: 'c-1' }));
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('removes it when the answer is yes', async () => {
    const store = seededStore();
    const confirmDeleteComment = vi.fn(async () => true);
    mount({ comments: store, confirmDeleteComment });

    openThread().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(store.remove).toHaveBeenCalledWith('c-1');
  });

  it('does not delete at all when there is nothing to ask with', async () => {
    const store = seededStore();
    mount({ comments: store });

    openThread().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(store.remove).not.toHaveBeenCalled();
  });
});
