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
