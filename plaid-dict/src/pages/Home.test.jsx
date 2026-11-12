import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

const state = vi.hoisted(() => ({
  user: { id: 'student@x.com' },
  catalog: { vocabularies: [], projects: [], itemCounts: {}, loading: false, error: '' },
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock('@/contexts/CatalogContext', () => ({ useCatalog: () => state.catalog }));
vi.mock('@/hooks/useDocumentTitle', () => ({ useDocumentTitle: () => {} }));
const { Home } = await import('./Home.jsx');

const render = () =>
  renderComponent(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );

// H1 S5: with nothing to list, the page names no other app.
describe('the landing page with no dictionaries', () => {
  it('says so and names no other app', async () => {
    state.user = { id: 'student@x.com' };
    state.catalog = { vocabularies: [], projects: [], itemCounts: {}, loading: false, error: '' };
    const view = await render();
    expect(view.container.textContent).toContain('No dictionaries.');
    expect(view.container.textContent).not.toMatch(/IGT/);
    await view.unmount();
  });
});

// A dictionary is edited, and a vocabulary set up as one, by a maintainer of
// the vocabulary's project only. Writers and readers there, and the people of
// a project that only links the vocabulary, read it and see no edit control.
describe('who sees Edit and Set up', () => {
  const me = 'ann@x.com';
  const vocabularies = [
    { id: 'd1', name: 'Sena', project: 'A', config: { dict: { slug: 'sena', title: 'Sena' } } },
    { id: 'v2', name: 'Roots', project: 'A', config: {} },
  ];
  const role = (r) => [
    { id: 'A', name: 'A', maintainers: [], writers: [], readers: [], [r]: [me] },
    // B borrows both and ann maintains it.
    { id: 'B', name: 'B', maintainers: [me], writers: [], readers: [] },
  ];
  const seen = async (projects) => {
    state.user = { id: me, isAdmin: false };
    state.catalog = { vocabularies, projects, itemCounts: {}, loading: false, error: '' };
    const view = await render();
    const links = [...view.container.querySelectorAll('a')].map((a) => a.textContent.trim());
    await view.unmount();
    return {
      edit: links.includes('Edit'),
      setUp: links.includes('Set up'),
      dict: links.includes('Sena'),
    };
  };

  it('a maintainer of the home sees both', async () => {
    expect(await seen(role('maintainers'))).toEqual({ edit: true, setUp: true, dict: true });
  });

  it('a writer or reader of the home sees neither', async () => {
    expect(await seen(role('writers'))).toEqual({ edit: false, setUp: false, dict: true });
    expect(await seen(role('readers'))).toEqual({ edit: false, setUp: false, dict: true });
  });

  it('a maintainer of a borrowing project with no role in the home sees neither', async () => {
    const projects = [{ id: 'B', name: 'B', maintainers: [me], writers: [], readers: [] }];
    expect(await seen(projects)).toEqual({ edit: false, setUp: false, dict: true });
  });
});
