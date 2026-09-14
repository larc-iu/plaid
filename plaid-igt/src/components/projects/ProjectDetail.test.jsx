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
  DocumentList: ({ documents, projectId }) => {
    listed.push({ projectId, ids: documents.map((d) => d.id).join(',') });
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

  it('shows what the one project it was asked for said', async () => {
    const d = deferred();
    auth.client = d.client;
    const view = await renderComponent(app);
    await view.step(async () => d.settle('A'));
    expect(heading(view.container)).toBe('Ayvale');
    await view.unmount();
  });
});
