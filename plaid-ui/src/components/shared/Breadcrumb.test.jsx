import { describe, it, expect, afterEach } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderComponent, all, texts } from '../../test/renderComponent.jsx';
import { Breadcrumb } from './Breadcrumb.jsx';

// The trail at the top of a page: grey links, the current page dark and not a
// link, and every label free to take its own direction.

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
  { label: 'One', to: '/projects/p1/documents/d1' },
];

afterEach(async () => {
  if (view) await view.unmount();
  view = null;
});

describe('Breadcrumb', () => {
  it('draws the trail in order, the separators hidden from a screen reader', async () => {
    await mount(TRAIL);
    const nav = view.container.querySelector('nav');
    expect(nav.getAttribute('aria-label')).toBe('Breadcrumb');
    expect(texts(view.container, 'li:not([aria-hidden])')).toEqual(['Projects', 'Ay', 'One']);
    expect(all(view.container, 'li[aria-hidden="true"]').map((n) => n.textContent)).toEqual([
      '/',
      '/',
    ]);
  });

  it('makes every item but the last a real link to its place', async () => {
    await mount(TRAIL);
    const links = all(view.container, 'a');
    expect(links.map((a) => a.textContent)).toEqual(['Projects', 'Ay']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/projects',
      '/projects/p1/documents',
    ]);
  });

  it('shows the current page dark and unlinked, even when it was given a place', async () => {
    await mount(TRAIL);
    const current = view.container.querySelector('[aria-current="page"]');
    expect(current.tagName).toBe('SPAN');
    expect(current.textContent).toBe('One');
    expect(current.className).toContain('text-foreground');
    expect(current.closest('a')).toBeNull();
    for (const a of all(view.container, 'a')) {
      expect(a.className).toContain('text-muted-foreground');
      expect(a.className).toContain('hover:underline');
    }
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
    const labels = [...all(view.container, 'a'), view.container.querySelector('[aria-current]')];
    expect(labels.map((n) => n.getAttribute('dir'))).toEqual(['auto', 'auto', 'auto']);
    // The chrome is not language data: no direction on the trail or its list.
    expect(view.container.querySelector('nav').hasAttribute('dir')).toBe(false);
    expect(view.container.querySelector('ol').hasAttribute('dir')).toBe(false);
    expect(texts(view.container, 'li:not([aria-hidden])')).toEqual(['Projects', 'مشروع', 'نص أول']);
  });

  it('shows a lone item as the current page', async () => {
    await mount([{ label: 'Projects', to: '/projects' }]);
    expect(all(view.container, 'a')).toEqual([]);
    expect(view.container.querySelector('[aria-current="page"]').textContent).toBe('Projects');
  });
});
