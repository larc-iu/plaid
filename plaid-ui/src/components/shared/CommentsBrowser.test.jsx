import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '../../test/renderComponent.jsx';
import { CommentsBrowser } from './CommentsBrowser.jsx';

// The control that opens what a thread is about is a destination, so it is an
// anchor: middle-click, cmd-click and the right-click menu are how people open
// something in a new tab, and a button has no URL for the browser to open.

const comment = (id) => ({
  id,
  body: `about ${id}`,
  createdAt: '2026-09-01T00:00:00Z',
  authorId: 'u',
  anchorLabel: 'Sentence 1',
});

// The smallest store the browser reads.
const store = () => ({
  getSnapshot: () => 1,
  subscribe: () => () => {},
  authorName: () => 'u',
  threads: () => [{ entityType: 'sentence', entityId: 's1', comments: [comment('c1')] }],
});

const anchors = new Map([['s1', { label: 'Sentence 1', kind: 'sentence', jumpId: 's1' }]]);

const browse = (props) => (
  <MemoryRouter>
    <CommentsBrowser
      store={store()}
      anchors={anchors}
      canWrite={false}
      canDeleteAny={false}
      jumpTitle="Show this sentence in the editor"
      emptyText="Nothing yet."
      {...props}
    />
  </MemoryRouter>
);

describe('the control that opens what a thread is about', () => {
  it('is a real link, so it can be opened in a new tab', async () => {
    const view = await renderComponent(
      browse({ jumpHref: (id) => `/projects/p/documents/d/annotate?sent=${id}` }),
    );
    const jump = view.container.querySelector('[aria-label="Show this sentence in the editor"]');
    expect(jump).not.toBe(null);
    expect(jump.tagName).toBe('A');
    expect(jump.getAttribute('href')).toBe('/projects/p/documents/d/annotate?sent=s1');
    await view.unmount();
  });

  it('is absent where the caller names no destination', async () => {
    const view = await renderComponent(browse({}));
    expect(view.container.querySelector('[aria-label="Show this sentence in the editor"]')).toBe(
      null,
    );
    await view.unmount();
  });
});

// The document's own thread is pinned above the list. Once it has a comment it
// is one of the threads on screen, and a count that left it out said "0
// threads" above it.
describe('the counts', () => {
  const withDoc = (docComments) => ({
    ...store(),
    threads: () => [
      { entityType: 'sentence', entityId: 's1', comments: [comment('c1')] },
      ...(docComments ? [{ entityType: 'document', entityId: 'd1', comments: docComments }] : []),
    ],
  });
  const counts = (container) => ({
    list: container.querySelector('span.whitespace-nowrap').textContent,
    current: container.querySelector('[aria-label="Which threads"] button').textContent,
  });

  it('count the pinned thread once it has a comment', async () => {
    const view = await renderComponent(browse({ store: withDoc([comment('c2')]), pinnedId: 'd1' }));
    expect(counts(view.container)).toEqual({ list: '2 threads', current: 'Current2' });
    await view.unmount();
  });

  it('leave out a pinned thread with nothing in it', async () => {
    const view = await renderComponent(browse({ store: withDoc(null), pinnedId: 'd1' }));
    expect(counts(view.container)).toEqual({ list: '1 thread', current: 'Current1' });
    await view.unmount();
  });
});

describe('a thread header', () => {
  it('lets the excerpt and the latest comment take their own direction', async () => {
    const view = await renderComponent(
      browse({
        anchors: new Map([
          ['s1', { label: 'Sentence 1', detail: 'قرأ الولد الكتاب.', jumpId: 's1' }],
        ]),
      }),
    );
    const excerpt = [...view.container.querySelectorAll('span')].find(
      (s) => s.textContent === 'قرأ الولد الكتاب.',
    );
    expect(excerpt?.getAttribute('dir')).toBe('rtl');
    const preview = [...view.container.querySelectorAll('span')].find(
      (s) => s.textContent === 'about c1',
    );
    expect(preview?.getAttribute('dir')).toBe('auto');
    await view.unmount();
  });

  it('gives the excerpt the direction most of its letters read in, not its first word', async () => {
    for (const [detail, dir] of [
      ['CNN قالت إن الاقتصاد ينمو.', 'rtl'],
      ['قال he would come tomorrow.', 'ltr'],
    ]) {
      const view = await renderComponent(
        browse({ anchors: new Map([['s1', { label: 'Sentence 1', detail, jumpId: 's1' }]]) }),
      );
      const excerpt = [...view.container.querySelectorAll('span')].find(
        (s) => s.textContent === detail,
      );
      expect(excerpt?.getAttribute('dir')).toBe(dir);
      await view.unmount();
    }
  });
});
