import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent, all, texts } from '../../test/renderComponent.jsx';

// The Documents tab plaid-ud and plaid-umr share. What each app hands it is
// stood in by plain data here, the way the two apps' wrappers hand theirs.

const auth = vi.hoisted(() => ({ getClient: vi.fn(), logout: vi.fn(), user: null }));
vi.mock('../../contexts/useAuth.js', () => ({ useAuth: () => auth }));
vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { ProjectDocumentsPage } = await import('./ProjectDocumentsPage.jsx');

const DOCS = [
  { id: 'd1', name: 'Alpha', timeModified: '2026-09-01T00:00:00Z' },
  { id: 'd2', name: 'Zeta', timeModified: '2026-09-03T00:00:00Z' },
  { id: 'd3', name: 'Mid', timeModified: '2026-09-02T00:00:00Z' },
];

const project = (role, configured = true) => ({
  id: 'p1',
  name: 'Ay',
  configured,
  maintainers: role === 'maintainer' ? ['u'] : [],
  writers: role === 'writer' ? ['u'] : [],
  readers: role === 'reader' ? ['u'] : [],
});

const adopt = vi.fn(async () => {});
const seen = vi.hoisted(() => ({ documents: null }));
const NewDocument = ({ documents }) => {
  seen.documents = documents;
  return <button type="button">New thing</button>;
};

const page = (setup = {}) => (
  <MemoryRouter initialEntries={['/projects/p1/documents']}>
    <Routes>
      <Route
        path="/projects/:projectId/documents"
        element={
          <ProjectDocumentsPage
            tabs={() => <nav>tabs</nav>}
            layerInfo={(p) => ({ isConfigured: !!p?.configured, words: 'wl' })}
            setup={{ app: 'XY', note: 'Layers are added.', adopt, ...setup }}
            tableLayers={(info) => ({ wordLayerId: info.words })}
            rowHref={(projectId, documentId) => `/p/${projectId}/d/${documentId}`}
            newDocument={NewDocument}
          />
        }
      />
    </Routes>
  </MemoryRouter>
);

const serve = (p) =>
  auth.getClient.mockReturnValue({
    projects: {
      get: vi.fn(async () => p),
      listDocuments: vi.fn(async () => DOCS),
      myLastEdits: async () => ({}),
    },
    query: async () => ({ results: [] }),
  });

// Each row's document name, in row order (the cell also carries the id).
const names = (container) =>
  texts(container, 'tbody tr td:first-child').map((t) => t.replace(/ID: .*$/, ''));

const settle = () => new Promise((r) => setTimeout(r, 0));

const mount = async (p) => {
  serve(p);
  const view = await renderComponent(page());
  await view.step(settle);
  return view;
};

beforeEach(() => {
  auth.user = { id: 'u', isAdmin: false };
  seen.documents = null;
  adopt.mockClear();
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('the document list', () => {
  it('starts on the most recently updated document, as the project list does', async () => {
    const view = await mount(project('writer'));
    expect(names(view.container)).toEqual(['Zeta', 'Mid', 'Alpha']);
    await view.unmount();
  });

  it('keeps a sort the reader chose over the default', async () => {
    serve(project('writer'));
    let view = await renderComponent(page());
    await view.step(settle);
    const header = all(view.container, 'th button').find((b) => b.textContent.includes('Document'));
    await view.step(() => header.click());
    const chosen = names(view.container);
    expect(chosen).not.toEqual(['Zeta', 'Mid', 'Alpha']);
    await view.unmount();

    view = await renderComponent(page());
    await view.step(settle);
    expect(names(view.container)).toEqual(chosen);
    await view.unmount();
  });

  it('links each row where the app says, and heads the list with an h2', async () => {
    const view = await mount(project('reader'));
    const link = view.container.querySelector('tbody tr a');
    expect(link.getAttribute('href')).toMatch(/^\/p\/p1\/d\/d\d$/);
    expect(view.container.querySelector('h2').textContent).toBe('Documents in Ay');
    expect(view.container.querySelector('h1')).toBe(null);
    await view.unmount();
  });

  it("hands a writer the app's new-document control, with the documents", async () => {
    const view = await mount(project('writer'));
    expect(view.container.textContent).toContain('New thing');
    expect(seen.documents).toEqual(DOCS);
    await view.unmount();
  });

  it('gives a reader no new-document control', async () => {
    const view = await mount(project('reader'));
    expect(view.container.textContent).not.toContain('New thing');
    await view.unmount();
  });
});

describe('a project the app has no layers in', () => {
  it('offers a maintainer the one button, and it sets the project up', async () => {
    const view = await mount(project('maintainer', false));
    expect(view.container.textContent).toContain('Not set up for XY');
    expect(view.container.textContent).toContain('Layers are added.');
    const button = all(view.container, 'button').find((b) => b.textContent === 'Set up for XY');
    await view.step(async () => {
      button.click();
      await settle();
    });
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt.mock.calls[0][1].id).toBe('p1');
    expect(adopt.mock.calls[0][2]).toEqual({ isConfigured: false, words: 'wl' });
    await view.unmount();
  });

  it('tells anyone else to ask a maintainer, with no button', async () => {
    const view = await mount(project('writer', false));
    expect(view.container.textContent).toContain('Ask a project maintainer to add XY support.');
    expect(all(view.container, 'button').some((b) => b.textContent.startsWith('Set up'))).toBe(
      false,
    );
    await view.unmount();
  });

  it('shows a maintainer what the app cannot make instead of the button', async () => {
    serve(project('maintainer', false));
    const blocked = vi.fn((info, projectId) => ({
      title: 'Nothing here',
      body: `Go elsewhere for ${projectId}.`,
      action: <a href="#elsewhere">Elsewhere</a>,
    }));
    const view = await renderComponent(page({ blocked }));
    await view.step(settle);
    expect(view.container.textContent).toContain('Nothing here');
    expect(view.container.textContent).toContain('Go elsewhere for p1.');
    expect(view.container.textContent).not.toContain('Set up for XY');
    await view.unmount();
  });

  it('draws the notice in the warning tone', async () => {
    const view = await mount(project('maintainer', false));
    expect(view.container.querySelector('[data-tone="warning"]')).not.toBe(null);
    await view.unmount();
  });
});
