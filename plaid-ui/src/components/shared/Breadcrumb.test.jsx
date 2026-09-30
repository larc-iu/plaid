import { describe, it, expect, afterEach } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderComponent, all, texts } from '../../test/renderComponent.jsx';
import { Breadcrumb } from './Breadcrumb.jsx';

// The way back from a page: the places above it as grey links, each followed
// by a slash, and every label free to take its own direction. The page itself
// is its heading's, not the trail's.

const Where = () => <p data-testid="at">{useLocation().pathname}</p>;

let view = null;
const mount = async (items, path = '/projects/p1/documents/d1') => {
  view = await renderComponent(
    <MemoryRouter initialEntries={[path]}>
      <Breadcrumb items={items} />
      <Where />
    </MemoryRouter>,
  );
  return view;
};
const at = () => view.container.querySelector('[data-testid="at"]').textContent;

const TRAIL = [
  { label: 'Projects', to: '/projects' },
  { label: 'Ay', to: '/projects/p1/documents' },
];

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
});

describe('Breadcrumb', () => {
  it('draws the trail in order, a slash after each place, hidden from a screen reader', async () => {
    await mount(TRAIL);
    const nav = view.container.querySelector('nav');
    expect(nav.getAttribute('aria-label')).toBe('Breadcrumb');
    expect(texts(view.container, 'li:not([aria-hidden])')).toEqual(['Projects', 'Ay']);
    expect(all(view.container, 'li[aria-hidden="true"]').map((n) => n.textContent)).toEqual([
      '/',
      '/',
    ]);
  });

  it('makes every place a real grey link, and names no current page', async () => {
    await mount(TRAIL);
    const links = all(view.container, 'a');
    expect(links.map((a) => a.textContent)).toEqual(['Projects', 'Ay']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/projects',
      '/projects/p1/documents',
    ]);
    for (const a of links) {
      expect(a.className).toContain('text-muted-foreground');
      expect(a.className).toContain('hover:underline');
    }
    expect(view.container.querySelector('[aria-current]')).toBeNull();
  });

  it('shows a place with nowhere to go yet as plain grey text', async () => {
    await mount([{ label: 'Projects', to: '/projects' }, { label: 'Loading…' }]);
    expect(all(view.container, 'a').map((a) => a.textContent)).toEqual(['Projects']);
    const loading = all(view.container, 'li:not([aria-hidden]) span')[0];
    expect(loading.textContent).toBe('Loading…');
    expect(loading.className).toContain('text-muted-foreground');
  });

  it('follows a plain click, and leaves a modified one to the browser', async () => {
    await mount(TRAIL);
    const projects = all(view.container, 'a')[0];
    // Cmd-click and middle-click open a new browser tab: this one stays put.
    await view.step(() =>
      projects.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true }),
      ),
    );
    expect(at()).toBe('/projects/p1/documents/d1');
    await view.step(() =>
      projects.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      ),
    );
    expect(at()).toBe('/projects');
  });

  it('lets each label take its own direction, and keeps the trail itself left to right', async () => {
    await mount([
      { label: 'Projects', to: '/projects' },
      { label: 'مشروع', to: '/projects/p1/documents' },
      { label: 'نص أول' },
    ]);
    const labels = all(view.container, 'li:not([aria-hidden]) > *');
    expect(labels.map((n) => n.getAttribute('dir'))).toEqual(['auto', 'auto', 'auto']);
    // The chrome is not language data: no direction on the trail or its list.
    expect(view.container.querySelector('nav').hasAttribute('dir')).toBe(false);
    expect(view.container.querySelector('ol').hasAttribute('dir')).toBe(false);
    expect(texts(view.container, 'li:not([aria-hidden])')).toEqual(['Projects', 'مشروع', 'نص أول']);
  });

  it('never shrinks a fixed label, and lets a name truncate', async () => {
    await mount([
      { label: 'Projects', to: '/projects', fixed: true },
      { label: 'A project with a very long name', to: '/projects/p1/documents' },
      { label: 'Add ELAN documents', fixed: true },
    ]);
    const [projects, name, page] = all(view.container, 'li:not([aria-hidden])');
    for (const fixed of [projects, page]) {
      expect(fixed.className).toContain('shrink-0');
      expect(fixed.className).not.toContain('truncate');
    }
    // It grows to its own width and no further, from a basis of nothing, so a
    // long name never pushes the fixed labels onto a second line.
    expect(name.className.split(' ')).toEqual(
      expect.arrayContaining(['min-w-0', 'truncate', 'flex-1', 'max-w-fit']),
    );
    expect(name.className).not.toContain('shrink-0');
    // Fixed labels that cannot all fit wrap rather than push the page wide.
    expect(view.container.querySelector('ol').className).toContain('flex-wrap');
  });

  it('draws a lone place as a link with its slash', async () => {
    await mount([{ label: 'Projects', to: '/projects' }]);
    expect(all(view.container, 'a').map((a) => a.textContent)).toEqual(['Projects']);
    expect(all(view.container, 'li[aria-hidden="true"]')).toHaveLength(1);
  });
});
