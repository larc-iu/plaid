import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// One route component serves every project id, so walking from A to B keeps
// this hook mounted and starts a second read without ending the first. Nothing
// orders the two, and the settings tabs above this hook take LAYER IDS off the
// project it hands them: A landing last puts A's layers under a Save the reader
// makes on B.

vi.mock('../../utils/feedback.jsx', () => ({ notifyError: vi.fn() }));

const auth = vi.hoisted(() => ({ getClient: vi.fn(), user: { id: 'u', isAdmin: true } }));
vi.mock('../../contexts/AuthContext.jsx', () => ({ useAuth: () => auth }));

const { useManagedProject } = await import('./useManagedProject.js');

// One deferred `projects.get` per id.
const deferred = () => {
  const pending = new Map();
  return {
    settle: (id, project) => pending.get(id)(project),
    client: {
      projects: { get: (id) => new Promise((resolve) => pending.set(id, resolve)) },
    },
  };
};

let seen;
let go;

const Probe = () => {
  seen = useManagedProject();
  return null;
};

const Nav = () => {
  go = useNavigate();
  return null;
};

const app = (
  <MemoryRouter initialEntries={['/projects/A/general']}>
    <Nav />
    <Routes>
      <Route path="/projects/:projectId/general" element={<Probe />} />
      <Route path="/projects" element={<p>Projects</p>} />
    </Routes>
  </MemoryRouter>
);

beforeEach(() => {
  seen = null;
  auth.user = { id: 'u', isAdmin: true };
});

describe('the managed project when the reader walks to another one', () => {
  it('keeps the project it was last asked for, however late the other answers', async () => {
    const d = deferred();
    auth.getClient.mockReturnValue(d.client);
    const view = await renderComponent(app);

    await view.step(() => go('/projects/B/general'));
    await view.step(async () => d.settle('B', { id: 'B', name: 'Bee' }));
    await view.step(async () => d.settle('A', { id: 'A', name: 'Ay' }));

    expect(seen.project.id).toBe('B');
    await view.unmount();
  });

  it('ignores the project just left, answer and spinner both', async () => {
    const d = deferred();
    auth.getClient.mockReturnValue(d.client);
    const view = await renderComponent(app);

    await view.step(() => go('/projects/B/general'));
    // A answers first. It is still the project the reader left.
    await view.step(async () => d.settle('A', { id: 'A', name: 'Ay' }));
    expect(seen.project).toBe(null);
    // And its `finally` must not take down the spinner B is still under.
    expect(seen.loading).toBe(true);

    await view.step(async () => d.settle('B', { id: 'B', name: 'Bee' }));
    expect(seen.project.id).toBe('B');
    expect(seen.loading).toBe(false);
    await view.unmount();
  });

  // The guard is about the project the ROUTE names. Reading the one still in
  // hand makes walking from a project the reader manages to one they do not
  // briefly permitted, and a failed read leaves it permitted for good.
  it('does not take the project it left as leave to configure the next one', async () => {
    const d = deferred();
    auth.getClient.mockReturnValue(d.client);
    auth.user = { id: 'u' };
    const view = await renderComponent(app);
    await view.step(async () => d.settle('A', { id: 'A', name: 'Ay', maintainers: ['u'] }));
    expect(seen.canConfigure).toBe(true);

    await view.step(() => go('/projects/B/general'));
    expect(seen.project).toBe(null);
    expect(seen.canConfigure).toBe(false);

    await view.step(async () => d.settle('B', { id: 'B', name: 'Bee', maintainers: ['other'] }));
    expect(seen.canConfigure).toBe(false);
    await view.unmount();
  });

  it('shows what the one project it was asked for said', async () => {
    const d = deferred();
    auth.getClient.mockReturnValue(d.client);
    const view = await renderComponent(app);
    await view.step(async () => d.settle('A', { id: 'A', name: 'Ay' }));
    expect(seen.project.id).toBe('A');
    expect(seen.loading).toBe(false);
    await view.unmount();
  });
});
