import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// One route component serves every project id, so walking from A to B keeps
// this screen mounted and starts a second load without ending the first.
// Nothing orders them, and the Settings panel below takes LAYER IDS off the
// project it is handed: A landing last would put A's layers under a Save the
// reader makes on B.

// Every render of the list, with the project it was drawn for: the frame that
// carries the new id with the old rows is the one under test, and it is gone
// again before any effect has run.
const listed = vi.hoisted(() => []);
vi.mock('./DocumentList', () => ({
  DocumentList: ({ documents, project, projectId }) => {
    listed.push({ projectId, of: project?.id, ids: documents.map((d) => d.id).join(',') });
    return <div data-testid="docs">{documents.map((d) => d.id).join(',')}</div>;
  },
}));
vi.mock('./search/ProjectSearch.jsx', () => ({ ProjectSearch: () => null }));
vi.mock('./ProjectSettingsPanel', () => ({ ProjectSettingsPanel: () => null }));
vi.mock('@/hooks/useCompose', () => ({ useComposeProject: () => {} }));
vi.mock('@ui/components/assistant/useAssistantAvailable.js', () => ({
  useAssistantAvailable: () => false,
}));
vi.mock('@ui/components/assistant/subject.js', () => ({
  useAssistantSubject: () => {},
  useAskAssistant: () => () => {},
}));
vi.mock('./assistant/adapter.js', () => ({ IGT_ASSISTANT: { app: 'plaid-igt-agent' } }));

const auth = vi.hoisted(() => ({
  client: null,
  user: { id: 'u', isAdmin: true },
  logout: vi.fn(),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));
// The shared tab strip asks the package's own hook.
vi.mock('@ui/contexts/useAuth.js', () => ({ useAuth: () => auth }));

const { ProjectDetail } = await import('./ProjectDetail.jsx');

const PROJECTS = {
  A: { id: 'A', name: 'Ayvale', config: { igt: { initialized: true } } },
  B: { id: 'B', name: 'Beeworth', config: { igt: { initialized: true } } },
};

// One deferred project read per id. The document list answers at once, with a
// row named after its project, so a list from the project the reader left is
// recognizable.
const deferred = () => {
  const pending = new Map();
  return {
    settle: (id) => pending.get(id)(PROJECTS[id]),
    settleWith: (id, project) => pending.get(id)(project),
    client: {
      projects: {
        get: (id) => new Promise((resolve) => pending.set(id, resolve)),
        listDocuments: async (id) => [{ id: `${id}-doc`, name: `${id} doc` }],
      },
    },
  };
};

let go;

const Nav = () => {
  go = useNavigate();
  return null;
};

const app = (
  <MemoryRouter initialEntries={['/projects/A']}>
    <Nav />
    <Routes>
      <Route path="/projects/:projectId" element={<ProjectDetail />} />
    </Routes>
  </MemoryRouter>
);

const heading = (container) => container.querySelector('h1')?.textContent ?? '';
const docs = (container) => container.querySelector('[data-testid="docs"]')?.textContent ?? '';

describe('the project screen when the reader walks to another project', () => {
  it('keeps the project it was last asked for, however late the other answers', async () => {
    const d = deferred();
    auth.client = d.client;
    const view = await renderComponent(app);

    await view.step(() => go('/projects/B'));
    await view.step(async () => d.settle('B'));
    await view.step(async () => d.settle('A'));

    expect(heading(view.container)).toBe('Beeworth');
    await view.unmount();
  });

  it('shows the newest project even when the abandoned one answers first', async () => {
    const d = deferred();
    auth.client = d.client;
    const view = await renderComponent(app);

    await view.step(() => go('/projects/B'));
    await view.step(async () => d.settle('A'));
    expect(heading(view.container)).not.toBe('Ayvale');

    await view.step(async () => d.settle('B'));
    expect(heading(view.container)).toBe('Beeworth');
    await view.unmount();
  });

  // The rows are part of the project, and state set in an effect lands a frame
  // late: the render that first carries B's id still had A's rows in hand.
  it('never lists the documents of the project the reader left', async () => {
    const d = deferred();
    auth.client = d.client;
    listed.length = 0;
    const view = await renderComponent(app);
    await view.step(async () => d.settle('A'));
    expect(docs(view.container)).toBe('A-doc');

    await view.step(() => go('/projects/B'));
    await view.step(async () => d.settle('B'));
    expect(docs(view.container)).toBe('B-doc');

    const wrong = listed.filter((r) => r.ids && !r.ids.startsWith(r.projectId));
    expect(wrong).toEqual([]);
    await view.unmount();
  });

  // The same frame hands every tab the project itself, and Settings takes
  // layer ids off it: a tab must never be drawn for B with A in hand.
  it('never hands a tab the project the reader left', async () => {
    const d = deferred();
    auth.client = d.client;
    listed.length = 0;
    const view = await renderComponent(app);
    await view.step(async () => d.settle('A'));

    await view.step(() => go('/projects/B'));
    expect(heading(view.container)).not.toBe('Ayvale');
    await view.step(async () => d.settle('B'));
    expect(heading(view.container)).toBe('Beeworth');

    expect(listed.filter((r) => r.of !== r.projectId)).toEqual([]);
    await view.unmount();
  });

  it('shows what the one project it was asked for said', async () => {
    const d = deferred();
    auth.client = d.client;
    const view = await renderComponent(app);
    await view.step(async () => d.settle('A'));
    expect(heading(view.container)).toBe('Ayvale');
    await view.unmount();
  });
});

// The page wears the shared project tab strip: breadcrumb, a heading naming the
// project, and text tabs that are links, with the active one read off `?tab=`
// or the settings path by this page and handed to the strip.
describe('the project page header', () => {
  const at = (path) => (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:projectId" element={<ProjectDetail />} />
        <Route path="/projects/:projectId/general" element={<ProjectDetail />} />
      </Routes>
    </MemoryRouter>
  );
  const tabs = (container) =>
    [...container.querySelectorAll('[role="tab"]')].map((t) => ({
      name: t.textContent,
      href: t.getAttribute('href'),
      active: t.getAttribute('data-state') === 'active',
      icon: !!t.querySelector('svg'),
    }));

  it('names the project, trails back to Projects, and draws text tabs as links', async () => {
    const d = deferred();
    auth.client = d.client;
    const view = await renderComponent(at('/projects/A?tab=search'));
    await view.step(async () => d.settle('A'));

    expect(heading(view.container)).toBe('Ayvale');
    const crumb = view.container.querySelector('nav[aria-label="Breadcrumb"]');
    expect(crumb.querySelector('a').getAttribute('href')).toBe('/projects');
    expect(crumb.querySelector('[aria-current="page"]').textContent).toBe('Ayvale');

    const drawn = tabs(view.container);
    expect(drawn.map((t) => t.name)).toEqual([
      'Documents',
      'Search',
      'Guidelines',
      'Bulk Edit',
      'Validation',
      'Activity',
      'Export',
      'Settings',
    ]);
    expect(drawn.some((t) => t.icon)).toBe(false);
    expect(drawn.find((t) => t.active).name).toBe('Search');
    expect(drawn.find((t) => t.name === 'Validation').href).toBe('/projects/A?tab=validate');
    expect(drawn.find((t) => t.name === 'Settings').href).toBe('/projects/A/general');
    expect(drawn.find((t) => t.name === 'Export').href).toBe('/projects/A/export');
    await view.unmount();
  });

  it('marks Settings active on a settings section', async () => {
    const d = deferred();
    auth.client = d.client;
    const view = await renderComponent(at('/projects/A/general'));
    await view.step(async () => d.settle('A'));
    expect(tabs(view.container).find((t) => t.active).name).toBe('Settings');
    await view.unmount();
  });

  it('offers a reader no maintainer tabs', async () => {
    const d = deferred();
    auth.client = d.client;
    auth.user = { id: 'r', isAdmin: false };
    try {
      const view = await renderComponent(at('/projects/A'));
      await view.step(async () =>
        pendingReader(d, 'A', { maintainers: [], writers: [], readers: ['r'] }),
      );
      expect(tabs(view.container).map((t) => t.name)).toEqual([
        'Documents',
        'Search',
        'Guidelines',
        'Export',
      ]);
      await view.unmount();
    } finally {
      auth.user = { id: 'u', isAdmin: true };
    }
  });
});

// Settles one project read with extra ACL fields.
const pendingReader = (d, id, acl) => d.settleWith(id, { ...PROJECTS[id], ...acl });
