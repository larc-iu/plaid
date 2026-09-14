import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, texts } from '../../test/renderComponent.jsx';
import { AuditFeed } from './AuditFeed.jsx';

// `resetKey` re-scopes the feed (a different project, a different window) and
// starts a second read without ending the first. Nothing orders the two, so the
// scope just left can answer last and fill the feed with the wrong changes.

const entry = (id) => ({
  id,
  time: '2026-09-01T00:00:00Z',
  ops: [{ type: 'update', description: `changed ${id}` }],
  user: { id: 'u', displayName: 'u' },
});

// One deferred page per scope.
const deferred = () => {
  const pending = new Map();
  let scope = null;
  return {
    at: (key) => {
      scope = key;
    },
    settle: (key, entries, nextCursor = null) => pending.get(key)({ entries, nextCursor }),
    fetchPage: vi.fn(() => new Promise((resolve) => pending.set(scope, resolve))),
  };
};

const feed = (d, resetKey) => (
  <MemoryRouter>
    <AuditFeed
      fetchPage={d.fetchPage}
      resetKey={resetKey}
      title="Recent changes"
      projectHref={(project) => `/projects/${project.id}`}
      documentHref={(document, project) => `/projects/${project.id}/documents/${document.id}`}
    />
  </MemoryRouter>
);

const shown = (container) => texts(container, 'td').join(' ');

const olderButton = (container) =>
  [...container.querySelectorAll('button')].find((b) => /Load older|Loading/.test(b.textContent)) ??
  null;

describe('the audit feed when its scope changes under it', () => {
  it('keeps the scope it was last asked for, however late the other answers', async () => {
    const d = deferred();
    d.at('A');
    const view = await renderComponent(feed(d, 'A'));
    d.at('B');
    await view.rerender(feed(d, 'B'));

    await view.step(async () => d.settle('B', [entry('bee')]));
    await view.step(async () => d.settle('A', [entry('ay')]));

    expect(shown(view.container)).toContain('bee');
    expect(shown(view.container)).not.toContain('ay');
    await view.unmount();
  });

  it('shows the newest scope even when the abandoned one answers first', async () => {
    const d = deferred();
    d.at('A');
    const view = await renderComponent(feed(d, 'A'));
    d.at('B');
    await view.rerender(feed(d, 'B'));

    await view.step(async () => d.settle('A', [entry('ay')]));
    expect(shown(view.container)).not.toContain('ay');

    await view.step(async () => d.settle('B', [entry('bee')]));
    expect(shown(view.container)).toContain('bee');
    await view.unmount();
  });

  it('drops an older page that belongs to the scope just left', async () => {
    // The cursor and the rows on screen are the previous scope's until the new
    // first page lands, so "Load older" could append that scope's next page to
    // this one. Whichever half is fixed first, both have to be.
    const d = deferred();
    d.at('A');
    const view = await renderComponent(feed(d, 'A'));
    await view.step(async () => d.settle('A', [entry('ay')], 'more-of-a'));

    const older = olderButton(view.container);
    expect(older).not.toBe(null);
    d.at('A-older');
    await view.step(() => older.click());

    // The reader re-scopes while A's older page is still out.
    d.at('B');
    await view.rerender(feed(d, 'B'));
    await view.step(async () => d.settle('B', [entry('bee')]));
    await view.step(async () => d.settle('A-older', [entry('ay-older')]));

    expect(shown(view.container)).toContain('bee');
    expect(shown(view.container)).not.toContain('ay-older');
    await view.unmount();
  });

  it('leaves the older-changes button usable after a re-scope mid-fetch', async () => {
    // Same shape as above, read off the CONTROL rather than the rows: the two
    // reads share one counter, so the dropped older page skipped the flag its
    // own `finally` would have cleared and the button stayed "Loading…".
    const d = deferred();
    d.at('A');
    const view = await renderComponent(feed(d, 'A'));
    await view.step(async () => d.settle('A', [entry('ay')], 'more-of-a'));

    d.at('A-older');
    await view.step(() => olderButton(view.container).click());
    expect(olderButton(view.container).textContent).toContain('Loading');

    d.at('B');
    await view.rerender(feed(d, 'B'));
    await view.step(async () => d.settle('B', [entry('bee')], 'more-of-b'));
    await view.step(async () => d.settle('A-older', [entry('ay-older')]));

    const button = olderButton(view.container);
    expect(button.textContent).toContain('Load older');
    expect(button.disabled).toBe(false);
    await view.unmount();
  });

  it('shows what the one scope it was asked for said', async () => {
    const d = deferred();
    d.at('A');
    const view = await renderComponent(feed(d, 'A'));
    await view.step(async () => d.settle('A', [entry('ay')]));
    expect(shown(view.container)).toContain('ay');
    await view.unmount();
  });
});

describe('the href builders the app owes the feed', () => {
  it('are named when one is missing, rather than dropping the links', async () => {
    // Each app routes to a document differently, so the package cannot guess.
    // A feed mounted without them used to render the Where column as plain
    // text, which reads as "there is nothing to open here".
    const d = deferred();
    d.at('A');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      renderComponent(
        <MemoryRouter>
          <AuditFeed fetchPage={d.fetchPage} resetKey="A" projectHref={(p) => `/p/${p.id}`} />
        </MemoryRouter>,
      ),
    ).rejects.toThrow(/documentHref/);
    error.mockRestore();
  });
});
