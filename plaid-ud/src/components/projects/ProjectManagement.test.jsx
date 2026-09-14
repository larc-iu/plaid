import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { renderComponent, texts } from '@ui/test/renderComponent.jsx';
import { type } from '../../test/keyboard.js';

// Users and Permissions is one route component serving every project id, so
// walking from A to B keeps it mounted and starts a second read without ending
// the first. Nothing orders them: A answering last puts A's members and A's
// roles under B's settings, and the role pickers there write to whichever
// project the reader is on.

// The toasts are stubs, but `humanizeError` is the real one: what an error
// looks like once it has been through it is the subject of the second test
// below.
vi.mock('../../utils/feedback.jsx', async () => {
  const { humanizeError } = await import('@ui/lib/errors.js');
  return { notifySuccess: vi.fn(), notifyError: vi.fn(), humanizeError };
});
vi.mock('@ui/components/shared/ProjectInvites.jsx', () => ({ ProjectInvites: () => null }));
vi.mock('@ui/components/shared/MintedLinkDialog.jsx', () => ({ MintedLinkDialog: () => null }));
vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => async () => false }));

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

describe('the new-user banner', () => {
  beforeEach(() => {
    auth.user = { id: 'u', isAdmin: true };
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    auth.user = { id: 'u', isAdmin: false };
    vi.restoreAllMocks();
  });

  it('says what a refused create means rather than quoting the request', async () => {
    // The banner is rendered verbatim, so a raw client message puts the
    // request URL and the ids it carried on screen.
    const d = deferred();
    d.client.users.create = async () => {
      throw Object.assign(
        new Error('HTTP 503 Service Unavailable at http://localhost:8085/api/v1/users'),
        { status: 503 },
      );
    };
    auth.getClient.mockReturnValue(d.client);
    const view = await renderComponent(app);
    await view.step(async () => d.settle('A'));

    const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await view.step(() =>
      click(
        [...view.container.querySelectorAll('button')].find((b) =>
          /Create user/.test(b.textContent),
        ),
      ),
    );

    const field = (id) => document.body.querySelector(`#${id}`);
    await view.step(() => type(field('pm-new-email'), 'grace@example.com'));
    await view.step(() => type(field('pm-new-password'), 'hopper1'));
    await view.step(() => type(field('pm-new-password-confirm'), 'hopper1'));
    await view.step(async () => {
      field('pm-new-email')
        .closest('form')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    const banner = document.body.querySelector('[role="alert"]')?.textContent ?? '';
    expect(banner).toBe(
      'Failed to create user: Could not reach the server. Check your connection and try again.',
    );
    await view.unmount();
  });
});
