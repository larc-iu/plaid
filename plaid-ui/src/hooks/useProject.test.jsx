import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { renderComponent } from '../test/renderComponent.jsx';

// The Documents tab, Import and export, and ud's Search read the project
// without a stale-answer guard, so walking from A to B could put A's answer,
// landing last, under B (DEBT-UI-8). useProject is what they read it through
// now. useManagedProject.test.jsx covers the same hook under the guard.

const auth = vi.hoisted(() => ({ getClient: vi.fn(), logout: vi.fn() }));
vi.mock('../contexts/useAuth.js', () => ({ useAuth: () => auth }));

const { useProject } = await import('./useProject.js');

// One deferred `projects.get` and `listDocuments` per id.
const deferred = () => {
  const pending = new Map();
  const wait = (key) => new Promise((resolve, reject) => pending.set(key, { resolve, reject }));
  return {
    settle: (id) => {
      pending.get(`get:${id}`).resolve({ id, name: id });
      pending.get(`list:${id}`).resolve([{ id: `${id}-doc` }]);
    },
    fail: (id, err) => pending.get(`get:${id}`).reject(err),
    client: {
      projects: {
        get: (id) => wait(`get:${id}`),
        listDocuments: (id) => wait(`list:${id}`),
      },
    },
  };
};

let seen;
let go;
const Probe = ({ options }) => {
  seen = useProject(options);
  return null;
};
const Nav = () => {
  go = useNavigate();
  return null;
};
const app = (options) => (
  <MemoryRouter initialEntries={['/projects/A']}>
    <Nav />
    <Routes>
      <Route path="/projects/:projectId" element={<Probe options={options} />} />
    </Routes>
  </MemoryRouter>
);

describe('useProject when the reader walks to another project', () => {
  it('shows the project and documents last asked for, however late the other answers', async () => {
    const d = deferred();
    auth.getClient.mockReturnValue(d.client);
    const view = await renderComponent(app({ withDocuments: true }));
    await view.step(() => go('/projects/B'));
    await view.step(async () => d.settle('B'));
    await view.step(async () => d.settle('A'));
    expect(seen.project.id).toBe('B');
    expect(seen.documents).toEqual([{ id: 'B-doc' }]);
    expect(seen.loading).toBe(false);
    await view.unmount();
  });

  it('never shows the project it left under a failed read of the next', async () => {
    const d = deferred();
    auth.getClient.mockReturnValue(d.client);
    const view = await renderComponent(app({ withDocuments: true }));
    await view.step(async () => d.settle('A'));
    await view.step(() => go('/projects/B'));
    expect(seen.project).toBe(null);
    expect(seen.loading).toBe(true);
    await view.step(async () => d.fail('B', new Error('HTTP 500')));
    expect(seen.project).toBe(null);
    expect(seen.documents).toEqual([]);
    expect(seen.loading).toBe(false);
    expect(seen.error.message).toBe('HTTP 500');
    await view.unmount();
  });

  it('signs a reader refused as signed out out, when asked to', async () => {
    const d = deferred();
    auth.getClient.mockReturnValue(d.client);
    auth.logout.mockClear();
    const view = await renderComponent(app({ logoutOnAuthError: true }));
    await view.step(async () => d.fail('A', Object.assign(new Error('no'), { status: 401 })));
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(seen.error).toBe(null);
    await view.unmount();
  });
});
