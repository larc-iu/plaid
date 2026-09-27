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
    expect(texts(crumbs, 'li:not([aria-hidden])')).toEqual(['Projects', 'Ay', 'One']);
    // The document is the page the reader is on: named, not linked.
    expect(crumbs.querySelector('[aria-current="page"]').textContent).toBe('One');
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
    expect(texts(crumbs, 'li:not([aria-hidden])')).toEqual(['Projects', 'Loading…', 'Loading…']);
  });

  it('draws the status at the end of the breadcrumb row', async () => {
    await mount({ document: { name: 'One' }, status: <span data-testid="status">Saved</span> });
    const status = view.container.querySelector('[data-testid="status"]');
    expect(status.parentElement.className).toContain('ms-auto');
    expect(status.closest('nav')).toBeNull();
  });
});
