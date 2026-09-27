import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { SentenceComments } from './SentenceComments.jsx';
import { CommentStore } from '../../domain/CommentStore.js';

// The Comment action under a sentence, shared by plaid-ud and plaid-umr: a
// button with the count, a popover with the thread, a live claim while open.

const row = (id, entityId) => ({
  id,
  projectId: 'p1',
  documentId: 'd1',
  entityType: 'token',
  entityId,
  authorId: 'me@x.com',
  body: `comment ${id}`,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  edited: false,
});

const makeStore = async (rows = []) => {
  const client = {
    comments: {
      list: vi.fn(async () => rows),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    users: { get: vi.fn(async (id) => ({ id, displayName: id })) },
  };
  const store = new CommentStore({
    client,
    projectId: 'p1',
    documentId: 'd1',
    currentUserId: 'me@x.com',
  });
  store.onError = () => {};
  await store.load();
  return store;
};

let view;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const mount = async (props) => {
  view = await renderComponent(
    <SentenceComments sentenceId="s1" anchorLabel="Sentence 1: ذهب محمد" {...props} />,
  );
  return view.container.querySelector('button');
};

describe('SentenceComments', () => {
  it('draws nothing without a store, or for a reader where nobody has written', async () => {
    expect(await mount({ store: null, canWrite: true })).toBe(null);
    await view.unmount();
    expect(await mount({ store: await makeStore(), canWrite: false })).toBe(null);
  });

  it('offers a writer the action, in the host class beside the package one', async () => {
    const button = await mount({
      store: await makeStore(),
      canWrite: true,
      className: 'sentence-action',
    });
    expect(button.textContent.trim()).toBe('Comment');
    expect(button.getAttribute('aria-label')).toBe('Comment on this sentence');
    expect(button.classList).toContain('sentence-comments');
    expect(button.classList).toContain('sentence-action');
    expect(button.dataset.count).toBe('0');
  });

  it('shows a reader the count of what is there, and only this sentence’s', async () => {
    const store = await makeStore([row('c1', 's1'), row('c2', 's1'), row('c3', 's2')]);
    const button = await mount({ store, canWrite: false });
    expect(button.textContent.trim()).toBe('Comment2');
    expect(button.getAttribute('aria-label')).toBe('2 comments on this sentence');
    expect(button.querySelector('.tabular-nums').textContent).toBe('2');
  });

  it('opens the thread under its caption, and holds a live claim only while open', async () => {
    const store = await makeStore([row('c1', 's1')]);
    const release = vi.fn();
    const watch = vi.spyOn(store, 'watchLive').mockImplementation(() => release);
    const button = await mount({ store, canWrite: true });
    expect(watch).not.toHaveBeenCalled();

    await view.step(() => button.click());
    expect(watch).toHaveBeenCalledTimes(1);
    const caption = [...document.body.querySelectorAll('[dir="auto"]')].find(
      (el) => el.textContent === 'Sentence 1: ذهب محمد',
    );
    expect(caption).toBeTruthy();
    expect(document.body.textContent).toContain('comment c1');

    await view.step(() => button.click());
    expect(release).toHaveBeenCalledTimes(1);
  });
});
