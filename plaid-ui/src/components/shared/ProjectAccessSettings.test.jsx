import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { renderComponent, texts } from '../../test/renderComponent.jsx';

// Access is one route component serving every project id, so
// walking from A to B keeps it mounted and starts a second read without ending
// the first. Nothing orders them: A answering last puts A's members and A's
// roles under B's settings, and the role pickers there write to whichever
// project the reader is on.

// The screen itself is the shared one; what this drives is the route around it,
// so everything under it that fetches on its own is stubbed out.
vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));
vi.mock('./ProjectInvites.jsx', () => ({ ProjectInvites: () => null }));
vi.mock('./UserSearch.jsx', () => ({ UserSearch: () => null }));

const auth = vi.hoisted(() => ({ getClient: vi.fn(), user: { id: 'u', isAdmin: false } }));
vi.mock('../../contexts/useAuth.js', () => ({ useAuth: () => auth }));
// The access screen's password field asks the server for its minimum.
vi.mock('../../services/auth.js', () => ({ authService: { serverLimits: async () => ({}) } }));

const { ProjectAccessSettings } = await import('./ProjectAccessSettings.jsx');

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
      <Route
        path="/projects/:projectId/management"
        element={<ProjectAccessSettings roleOptions={[]} profileHref="/profile" />}
      />
    </Routes>
  </MemoryRouter>
);

const members = (container) => texts(container, 'td').join(' ');

beforeEach(() => {
  go = null;
  auth.user = { id: 'u', isAdmin: false };
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

describe('the Access section', () => {
  it('holds the API tokens beside the members', async () => {
    const d = deferred();
    auth.getClient.mockReturnValue(d.client);
    const view = await renderComponent(app);
    await view.step(async () => d.settle('A'));
    expect(view.container.textContent).toContain('API tokens');
    const manage = [...view.container.querySelectorAll('a')].find(
      (a) => a.textContent === 'Manage API tokens',
    );
    expect(manage.getAttribute('href')).toBe('/profile');
    await view.unmount();
  });

  it('shows nothing of the project to someone who does not manage it', async () => {
    const d = deferred();
    auth.getClient.mockReturnValue(d.client);
    auth.user = { id: 'nobody', isAdmin: false };
    const view = await renderComponent(app);
    await view.step(async () => d.settle('A'));
    expect(view.container.querySelector('[role="alert"]').textContent).toBe(
      'You do not have permission to manage this project.',
    );
    expect(members(view.container)).toBe('');
    expect(view.container.textContent).not.toContain('API tokens');
    await view.unmount();
  });
});
