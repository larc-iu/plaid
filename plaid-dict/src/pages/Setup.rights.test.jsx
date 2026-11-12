import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// Setup writes the vocabulary's settings, which only a maintainer of the
// vocabulary's project (or an admin) may change. Anyone else gets the page
// that says it cannot be set up, with no form.

const state = vi.hoisted(() => ({ user: null, projects: [] }));

vi.mock('@ui/lib/notify.js', () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }));

vi.mock('@/contexts/AuthContext', () => {
  const client = {
    projects: { list: async () => state.projects },
    vocabLayers: { get: async () => ({ items: [] }) },
  };
  return { useAuth: () => ({ client, user: state.user }) };
});

vi.mock('@/contexts/CatalogContext', () => {
  const vocabularies = [{ id: 'v1', name: 'Sena', project: 'A', config: {} }];
  return {
    useCatalog: () => ({
      vocabularies,
      allVocabularies: vocabularies,
      projects: state.projects,
      loading: false,
      reload: async () => {},
    }),
  };
});

const { Setup } = await import('./Setup.jsx');

const me = 'ann@x.com';
const home = (r) => ({ id: 'A', name: 'A', maintainers: [], writers: [], readers: [], [r]: [me] });

const open = async ({ user = { id: me, isAdmin: false }, projects }) => {
  state.user = user;
  state.projects = projects;
  const view = await renderComponent(
    <MemoryRouter initialEntries={['/setup/v1']}>
      <Routes>
        <Route path="/setup/:vocabularyId" element={<Setup />} />
      </Routes>
    </MemoryRouter>,
  );
  const seen = {
    form: !!view.container.querySelector('#title'),
    refused: view.container.textContent.includes(
      'This vocabulary cannot be set up as a dictionary.',
    ),
  };
  await view.unmount();
  return seen;
};

describe('dictionary Setup, by role in the vocabulary’s project', () => {
  it('opens for a maintainer of the project and for an admin', async () => {
    expect(await open({ projects: [home('maintainers')] })).toEqual({ form: true, refused: false });
    expect(
      await open({
        user: { id: 'root@x.com', isAdmin: true },
        projects: [home('maintainers')],
      }),
    ).toEqual({ form: true, refused: false });
  });

  it('is refused to a writer or reader of the project', async () => {
    expect(await open({ projects: [home('writers')] })).toEqual({ form: false, refused: true });
    expect(await open({ projects: [home('readers')] })).toEqual({ form: false, refused: true });
  });

  it('is refused to a maintainer of a project that only links the vocabulary', async () => {
    const borrower = { id: 'B', name: 'B', maintainers: [me], writers: [], readers: [] };
    expect(await open({ projects: [borrower] })).toEqual({ form: false, refused: true });
  });
});
