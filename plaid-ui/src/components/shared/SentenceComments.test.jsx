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

  // Dimmed to 0.6, the gray label measured under 3:1 on white. Quiet comes
  // from the missing border and fill, never from opacity.
  it('is at full strength at rest', async () => {
    const button = await mount({ store: await makeStore(), canWrite: true });
    expect(button.className).not.toMatch(/(^|\s)(hover:|focus-visible:)?opacity-/);
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

  // The thread is portaled, but React bubbles its keys through the component
  // tree into the grid or canvas around the button, where Enter on a thread's
  // button meant "edit the focused node".
  it("keeps the thread's keys from the host around it", async () => {
    const host = vi.fn();
    const store = await makeStore([row('c1', 's1')]);
    view = await renderComponent(
      <div onKeyDown={host}>
        <SentenceComments sentenceId="s1" anchorLabel="Sentence 1" store={store} canWrite />
      </div>,
    );
    const button = view.container.querySelector('button');
    await view.step(() => button.click());
    const inside = document.body.querySelector('[data-radix-popper-content-wrapper] textarea');
    await view.step(() =>
      inside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(host).not.toHaveBeenCalled();
    // The button itself is the host's, and its keys still reach it.
    await view.step(() =>
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })),
    );
    expect(host).toHaveBeenCalledTimes(1);
  });

  // The popover hangs off an anchor, not a Radix trigger, so Radix had nowhere
  // to put focus back and Escape left a keyboard reader on the page's body,
  // out of the grid or the canvas.
  it('hands focus back to the button when Escape closes the thread', async () => {
    const button = await mount({ store: await makeStore([row('c1', 's1')]), canWrite: true });
    await view.step(() => button.click());
    const inside = document.body.querySelector('[data-radix-popper-content-wrapper] textarea');
    expect(inside).toBeTruthy();
    await view.step(() => inside.focus());
    await view.step(() =>
      inside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    // Radix hands focus on from a timeout once the popover has unmounted.
    await view.step(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.body.querySelector('[data-radix-popper-content-wrapper]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
