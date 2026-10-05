import { describe, it, expect, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all, texts } from '../../test/renderComponent.jsx';
import { DocumentTabStrip } from './DocumentTabStrip.jsx';

// The breadcrumb and tab row over an open document, in every app. The app
// hands it its tabs as data, and the routes it links to come from the app's
// descriptor (the vitest setup file names one, as `main.jsx` does).

const PROJECT = { id: 'p1', name: 'Ay', maintainers: ['u'], writers: [], readers: [] };
const TABS = [
  { value: 'edit', label: 'Text', to: '/projects/p1/documents/d1/edit' },
  { value: 'details', label: 'Details', to: '/projects/p1/documents/d1/details' },
];

let view = null;
const mount = async (props, path = '/projects/p1/documents/d1/details') => {
  view = await renderComponent(
    <MemoryRouter initialEntries={[path]}>
      <DocumentTabStrip projectId="p1" project={PROJECT} tabs={TABS} {...props} />
    </MemoryRouter>,
  );
  return view;
};

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
});

describe('DocumentTabStrip', () => {
  it('draws the breadcrumb and every tab as a link', async () => {
    await mount({ document: { name: 'One' } });
    const crumbs = view.container.querySelector('nav[aria-label="Breadcrumb"]');
    // The trail ends at the project: the heading names the document.
    expect(texts(crumbs, 'li:not([aria-hidden])')).toEqual(['Projects', 'Ay']);
    expect(all(crumbs, 'a').map((a) => a.textContent)).toEqual(['Projects', 'Ay']);
    expect(texts(view.container, '[role="tab"]')).toEqual(['Text', 'Details']);
    // The tab standing on this path is the one that is on.
    const active = all(view.container, '[role="tab"]').find(
      (t) => t.getAttribute('data-state') === 'active',
    );
    expect(active.textContent).toBe('Details');
  });

  it('says Loading… for a project and a document not read yet', async () => {
    await mount({ project: null, document: null });
    const crumbs = view.container.querySelector('nav[aria-label="Breadcrumb"]');
    expect(texts(crumbs, 'li:not([aria-hidden])')).toEqual(['Projects', 'Loading…']);
    expect(view.container.querySelector('h1').textContent).toBe('Loading…');
  });

  it('draws the status at the end of the breadcrumb row', async () => {
    await mount({ document: { name: 'One' }, status: <span data-testid="status">Saved</span> });
    const status = view.container.querySelector('[data-testid="status"]');
    expect(status.parentElement.className).toContain('ms-auto');
    expect(status.closest('nav')).toBeNull();
  });

  it('names the document in a heading between the breadcrumb and the tabs', async () => {
    await mount({ document: { name: 'قصة' } });
    const h1 = view.container.querySelector('h1');
    expect(h1.textContent).toBe('قصة');
    // A name is data in any script. The chrome around it stays left to right.
    expect(h1.hasAttribute('dir')).toBe(false);
    expect(h1.querySelector('[dir="auto"]').textContent).toBe('قصة');
    const order = [...view.container.querySelectorAll('nav, h1, [role="tablist"]')].map((e) =>
      e.tagName.toLowerCase(),
    );
    expect(order).toEqual(['nav', 'h1', 'div']);
  });

  it('draws the actions at the end of the tab row', async () => {
    await mount({
      document: { name: 'One' },
      actions: <button data-testid="history">History</button>,
    });
    const row = view.container.querySelector('[data-testid="document-tab-row"]');
    const history = row.querySelector('[data-testid="history"]');
    expect(history).not.toBeNull();
    expect(history.parentElement.className).toContain('ms-auto');
  });

  it('counts a tab only when there is something to count', async () => {
    const tabs = [
      { value: 'comments', label: 'Comments', to: '/c', count: 3 },
      { value: 'details', label: 'Details', to: '/d', count: 0 },
    ];
    await mount({ document: { name: 'One' }, tabs });
    expect(texts(view.container, '[role="tab"]')).toEqual(['Comments3', 'Details']);
  });

  it('takes the active tab from the caller where the URL keeps it in the query', async () => {
    const tabs = [
      { value: 'analyze', label: 'Analyze', to: '/projects/p1/documents/d1?tab=analyze' },
      { value: 'details', label: 'Details', to: '/projects/p1/documents/d1?tab=details' },
    ];
    await mount(
      { document: { name: 'One' }, tabs, active: 'analyze' },
      '/projects/p1/documents/d1',
    );
    const active = all(view.container, '[role="tab"]').find(
      (t) => t.getAttribute('data-state') === 'active',
    );
    expect(active.textContent).toBe('Analyze');
    expect(all(view.container, '[role="tab"]').map((t) => t.getAttribute('href'))).toEqual([
      '/projects/p1/documents/d1?tab=analyze',
      '/projects/p1/documents/d1?tab=details',
    ]);
  });

  it('pins only the tab row when sticky, under the header offset', async () => {
    await mount({ document: { name: 'One' }, sticky: true });
    const row = view.container.querySelector('[data-testid="document-tab-row"]');
    expect(row.className).toContain('sticky');
    expect(row.className).toContain('top-[var(--plaid-sticky-top,0px)]');
    // The strip lays out in its parent's box, or the row could not stay pinned
    // past the strip's own height.
    expect(row.parentElement.className).toBe('contents');
    expect(row.hasAttribute('data-pinned')).toBe(true);
  });

  it('pads each part by the inset when the page runs to the edge', async () => {
    await mount({ document: { name: 'One' }, sticky: true, inset: 'px-6' });
    const row = view.container.querySelector('[data-testid="document-tab-row"]');
    const parts = [...row.parentElement.children];
    expect(parts).toHaveLength(3);
    for (const part of parts) expect(part.className.split(' ')).toContain('px-6');
  });

  // On a phone the tabs and History wrap to a second line, so the scroll
  // padding that keeps a deep-linked row out from under the pinned row takes
  // the row's measured height, not a one-line guess.
  it("hands the pinned row's measured height to the page, and takes it back", async () => {
    const observers = [];
    const Real = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb) {
        this.cb = cb;
        this.targets = [];
        observers.push(this);
      }
      observe(el) {
        this.targets.push(el);
      }
      disconnect() {
        this.targets = [];
      }
    };
    const root = window.document.documentElement;
    try {
      await mount({ document: { name: 'One' }, sticky: true });
      const row = view.container.querySelector('[data-testid="document-tab-row"]');
      const watcher = observers.find((o) => o.targets.includes(row));
      expect(watcher).toBeTruthy();
      Object.defineProperty(row, 'offsetHeight', { configurable: true, value: 93 });
      watcher.cb([]);
      expect(root.style.getPropertyValue('--plaid-tab-row-height')).toBe('93px');
      await view.unmount();
      view = null;
      expect(root.style.getPropertyValue('--plaid-tab-row-height')).toBe('');

      // A strip that is not pinned measures nothing.
      await mount({ document: { name: 'One' } });
      const flat = view.container.querySelector('[data-testid="document-tab-row"]');
      expect(observers.some((o) => o.targets.includes(flat))).toBe(false);
      expect(root.style.getPropertyValue('--plaid-tab-row-height')).toBe('');
    } finally {
      globalThis.ResizeObserver = Real;
    }
  });

  it('turns every tab into a disabled button while the body is busy', async () => {
    await mount({ document: { name: 'One' }, disabled: true });
    const tabs = all(view.container, '[role="tab"]');
    expect(tabs.every((t) => t.tagName === 'BUTTON' && t.disabled)).toBe(true);
  });
});

describe('the pinned row, once the heading has scrolled away', () => {
  // The page has no layout under test, so where the heading and the row
  // stand is said outright: the heading's bottom against the row's top.
  const place = (headingBottom, rowTop) => {
    const h1 = view.container.querySelector('h1');
    const row = view.container.querySelector('[data-testid="document-tab-row"]');
    h1.getBoundingClientRect = () => ({ bottom: headingBottom });
    row.getBoundingClientRect = () => ({ top: rowTop });
  };
  const scroll = () =>
    view.step(async () => {
      window.dispatchEvent(new Event('scroll'));
      await new Promise((r) => window.requestAnimationFrame(() => r()));
    });

  it('starts with a link back to the project, and only then', async () => {
    await mount({ document: { name: 'One' }, sticky: true });
    place(200, 120);
    await scroll();
    expect(view.container.querySelector('[data-testid="tab-row-project"]')).toBeNull();
    place(40, 57);
    await scroll();
    const link = view.container.querySelector('[data-testid="tab-row-project"]');
    expect(link.getAttribute('href')).toContain('/projects/p1');
    expect(link.getAttribute('aria-label')).toBe('Ay');
  });

  it('is never drawn on a strip that is not pinned', async () => {
    await mount({ document: { name: 'One' } });
    place(40, 57);
    await scroll();
    expect(view.container.querySelector('[data-testid="tab-row-project"]')).toBeNull();
  });
});
