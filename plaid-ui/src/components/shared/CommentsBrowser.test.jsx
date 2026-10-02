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

// A thread on something the app does not show, which is still in the document,
// is not outdated: it has its own group, offered only when it has threads.
describe('threads on other layers', () => {
  const withSpan = () => ({
    ...store(),
    threads: () => [
      { entityType: 'sentence', entityId: 's1', comments: [comment('c1')] },
      { entityType: 'span', entityId: 'g1', comments: [{ ...comment('c2'), anchorLabel: 'DOG' }] },
      { entityType: 'span', entityId: 'gone', comments: [{ ...comment('c3'), anchorLabel: 'X' }] },
    ],
  });
  const buttons = (container) =>
    [...container.querySelectorAll('[aria-label="Which threads"] button')].map((b) =>
      b.textContent.replace(/\s+/g, ' ').trim(),
    );

  it('are counted apart from the outdated ones', async () => {
    const view = await renderComponent(
      browse({ store: withSpan(), present: new Set(['s1', 'g1']) }),
    );
    expect(buttons(view.container)).toEqual(['Current1', 'On other layers1', 'Outdated1']);
    const other = [...view.container.querySelectorAll('[aria-label="Which threads"] button')][1];
    await view.step(() => other.click());
    expect(view.container.textContent).toContain('DOG');
    expect(view.container.textContent).not.toContain('outdated');
    await view.unmount();
  });

  it('offer no group where there are none', async () => {
    const view = await renderComponent(browse({ present: new Set(['s1']) }));
    expect(buttons(view.container)).toEqual(['Current1', 'Outdated0']);
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
          [
            's1',
            {
              label: 'Sentence 1',
              detail: 'قرأ الولد الكتاب.',
              excerpt: 'قرأ الولد الكتاب.',
              jumpId: 's1',
            },
          ],
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
        browse({
          anchors: new Map([
            ['s1', { label: 'Sentence 1', detail, excerpt: detail, jumpId: 's1' }],
          ]),
        }),
      );
      const excerpt = [...view.container.querySelectorAll('span')].find(
        (s) => s.textContent === detail,
      );
      expect(excerpt?.getAttribute('dir')).toBe(dir);
      await view.unmount();
    }
  });

  // What the letters are counted over is the excerpt alone. ud writes a
  // sentence that has a sent_id as "Sentence 4 · “…”", and the English
  // prefix counted too: a short Arabic sentence came out left to right, and a
  // longer one put "Sentence 4" at the right-hand end and split the quote.
  const headerOf = async (descriptor) => {
    const view = await renderComponent(
      browse({ anchors: new Map([['s1', { label: 'x1', jumpId: 's1', ...descriptor }]]) }),
    );
    const detail = view.container.querySelector('button.min-w-0 > span > span:nth-child(2)');
    return { view, detail };
  };

  it('counts the letters of the quoted sentence only, not the words around it', async () => {
    const { view, detail } = await headerOf({
      detail: 'Sentence 5 · “قرأ الولد.”',
      excerpt: 'قرأ الولد.',
    });
    expect(detail.textContent).toBe('Sentence 5 · “قرأ الولد.”');
    // The words around the quote are the app's and read left to right.
    expect(detail.getAttribute('dir')).toBe('auto');
    const quoted = detail.querySelector('bdi');
    expect(quoted?.textContent).toBe('قرأ الولد.');
    expect(quoted?.getAttribute('dir')).toBe('rtl');
    await view.unmount();
  });

  it('isolates a longer sentence so the prefix stays at the start', async () => {
    const { view, detail } = await headerOf({
      detail: 'Sentence 2 · “CNN قالت إن الاقتصاد ينمو.”',
      excerpt: 'CNN قالت إن الاقتصاد ينمو.',
    });
    expect(detail.getAttribute('dir')).toBe('auto');
    expect(detail.querySelector('bdi')?.getAttribute('dir')).toBe('rtl');
    expect(detail.firstChild.textContent).toBe('Sentence 2 · “');
    await view.unmount();
  });

  it('leaves a place such as "in <word>, sentence 4" to the browser', async () => {
    // A locator is the app's own words around a short value, not an excerpt.
    const { view, detail } = await headerOf({ detail: 'in الاستقلالية, sentence 4' });
    expect(detail.getAttribute('dir')).toBe('auto');
    expect(detail.querySelector('bdi')).toBe(null);
    await view.unmount();
  });

  it('gives an empty, a digits-only and an evenly mixed excerpt a direction', async () => {
    for (const [excerpt, dir] of [
      ['2020', 'ltr'],
      ['ab قل', 'ltr'],
      ['abc قلب', 'ltr'],
    ]) {
      const { view, detail } = await headerOf({ detail: `Sentence 1 · “${excerpt}”`, excerpt });
      expect(detail.querySelector('bdi')?.getAttribute('dir')).toBe(dir);
      await view.unmount();
    }
    // An empty excerpt marks nothing.
    const { view, detail } = await headerOf({ detail: 'Sentence 1', excerpt: '' });
    expect(detail.textContent).toBe('Sentence 1');
    expect(detail.getAttribute('dir')).toBe('auto');
    expect(detail.querySelector('bdi')).toBe(null);
    await view.unmount();
  });
});
