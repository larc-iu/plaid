import { describe, it, expect, vi, afterEach } from 'vitest';
import { useSyncExternalStore } from 'react';
import { renderComponent } from '../../test/renderComponent.jsx';
import { CommentThread } from './CommentThread.jsx';
import { CommentStore } from '../../domain/CommentStore.js';
import { hasUnsavedDraft } from '../../hooks/useUnsavedDraft.js';

// What was typed into a thread is kept until the server has it: a refused
// post puts it back in the composer, a refused edit opens the editor on it
// again, and leaving asks while any of it is unsaved.

const ME = 'me@x.com';

const row = (over = {}) => ({
  id: 'c1',
  projectId: 'p1',
  documentId: 'd1',
  entityType: 'token',
  entityId: 't1',
  authorId: ME,
  body: 'before',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  edited: false,
  ...over,
});

const makeStore = (rows = []) => {
  const client = {
    comments: {
      list: vi.fn(async () => rows),
      create: vi.fn(async () => {
        throw new Error('HTTP 500');
      }),
      update: vi.fn(async () => {
        throw new Error('HTTP 500');
      }),
      delete: vi.fn(async () => undefined),
    },
    users: { get: vi.fn(async (id) => ({ id, displayName: id })) },
  };
  const store = new CommentStore({
    client,
    projectId: 'p1',
    documentId: 'd1',
    currentUserId: ME,
  });
  store.onError = () => {};
  return { store, client };
};

// Type into a React-controlled textarea.
const type = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const button = (root, name) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === name);

let view;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

// The thread as a host mounts it: following the store.
const Host = ({ store }) => {
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <CommentThread
      store={store}
      comments={store.threadFor('t1')}
      canWrite
      entityType="token"
      entityId="t1"
    />
  );
};

const mount = async (store) => {
  await store.load();
  view = await renderComponent(<Host store={store} />);
  return view;
};

describe('a comment the server refuses', () => {
  it('comes back into the composer, and leaving asks until then', async () => {
    const { store, client } = makeStore();
    let refuse;
    client.comments.create.mockImplementationOnce(
      () => new Promise((_, reject) => (refuse = () => reject(new Error('HTTP 500')))),
    );
    await mount(store);
    const box = view.container.querySelector('textarea[aria-label="Add a comment"]');
    await view.step(() => type(box, 'hello there'));
    expect(hasUnsavedDraft()).toBe('The comment you have typed');
    await view.step(() => button(view.container, 'Comment').click());
    // On its way: the composer is empty, and the text is still asked about.
    expect(box.value).toBe('');
    expect(hasUnsavedDraft()).toBe('The comment you have typed');
    // Typed meanwhile, then refused: both are kept, the refused one first.
    await view.step(() => type(box, 'and more'));
    await view.step(async () => refuse());
    await view.step(async () => {});
    expect(box.value).toBe('hello there\n\nand more');
  });

  it('opens the editor on an edit it refused', async () => {
    const { store } = makeStore([row()]);
    await mount(store);
    const pencil = view.container.querySelector('[aria-label="Edit this comment"]');
    await view.step(() => pencil.click());
    const editor = view.container.querySelector('textarea[aria-label="Edit your comment"]');
    await view.step(() => type(editor, 'after'));
    await view.step(() => button(view.container, 'Save').click());
    await view.step(async () => {});
    const again = view.container.querySelector('textarea[aria-label="Edit your comment"]');
    expect(again).not.toBe(null);
    expect(again.value).toBe('after');
    expect(store.threadFor('t1')[0].body).toBe('before');
  });
});
