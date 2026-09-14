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
    <AuditFeed fetchPage={d.fetchPage} resetKey={resetKey} title="Recent changes" />
  </MemoryRouter>
);

const shown = (container) => texts(container, 'td').join(' ');

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

    const older = [...view.container.querySelectorAll('button')].find((b) =>
      /Load older/.test(b.textContent),
    );
    expect(older).not.toBe(undefined);
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

  it('shows what the one scope it was asked for said', async () => {
    const d = deferred();
    d.at('A');
    const view = await renderComponent(feed(d, 'A'));
    await view.step(async () => d.settle('A', [entry('ay')]));
    expect(shown(view.container)).toContain('ay');
    await view.unmount();
  });
});
