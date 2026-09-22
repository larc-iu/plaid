import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { renderComponent, texts } from '@ui/test/renderComponent.jsx';

// Users & Permissions is one route component serving every project id, so
// walking from A to B keeps it mounted and starts a second read without ending
// the first. Nothing orders them: A answering last puts A's members and A's
// roles under B's settings, and the role pickers there write to whichever
// project the reader is on.

// The screen itself is the shared one; what this drives is the route around it,
// so everything under it that fetches on its own is stubbed out.
vi.mock('../../utils/feedback.jsx', () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }));
vi.mock('@ui/components/shared/ProjectInvites.jsx', () => ({ ProjectInvites: () => null }));
vi.mock('@ui/components/shared/UserSearch.jsx', () => ({ UserSearch: () => null }));

const auth = vi.hoisted(() => ({ getClient: vi.fn(), user: { id: 'u', isAdmin: false } }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

const { ProjectManagement } = await import('./ProjectManagement.jsx');

const PROJECTS = {
  A: { id: 'A', name: 'Ay', maintainers: ['u', 'ada'], writers: [], readers: [] },
  B: { id: 'B', name: 'Bee', maintainers: ['u', 'grace'], writers: [], readers: [] },
};

// One deferred `projects.get` per id; the member lookups answer at once.
const deferred = () => {
  const pending = new Map();
  return {
    settle: (id) => pending.get(id)(PROJECTS[id]),
    client: {
      projects: { get: (id) => new Promise((resolve) => pending.set(id, resolve)) },
      users: {
        get: async (id) => ({ id, displayName: id, isAdmin: false }),
        avatarUrl: () => null,
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
  <MemoryRouter initialEntries={['/projects/A/management']}>
    <Nav />
    <Routes>
      <Route path="/projects/:projectId/management" element={<ProjectManagement />} />
    </Routes>
  </MemoryRouter>
);

const members = (container) => texts(container, 'td').join(' ');

beforeEach(() => {
  go = null;
});

describe('the members table when the reader walks to another project', () => {
  it('keeps the project it was last asked for, however late the other answers', async () => {
    const d = deferred();
    auth.getClient.mockReturnValue(d.client);
    const view = await renderComponent(app);

    await view.step(() => go('/projects/B/management'));
    await view.step(async () => d.settle('B'));
    await view.step(async () => d.settle('A'));

    expect(members(view.container)).toContain('grace');
    expect(members(view.container)).not.toContain('ada');
    await view.unmount();
  });

  it('shows the newest project even when the abandoned one answers first', async () => {
    const d = deferred();
    auth.getClient.mockReturnValue(d.client);
    const view = await renderComponent(app);

    await view.step(() => go('/projects/B/management'));
    await view.step(async () => d.settle('A'));
    expect(members(view.container)).not.toContain('ada');

    await view.step(async () => d.settle('B'));
    expect(members(view.container)).toContain('grace');
    await view.unmount();
  });

  it('shows what the one project it was asked for said', async () => {
    const d = deferred();
    auth.getClient.mockReturnValue(d.client);
    const view = await renderComponent(app);
    await view.step(async () => d.settle('A'));
    expect(members(view.container)).toContain('ada');
    await view.unmount();
  });
});
