import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, texts, all } from '../../test/renderComponent.jsx';
import { ProjectMembers } from './ProjectMembers.jsx';

const { toast } = vi.hoisted(() => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock('sonner', () => ({ toast }));

const ROLE_OPTIONS = [
  { value: 'none', label: 'No access', hint: 'None.' },
  { value: 'reader', label: 'Reader', hint: 'Reads.' },
  { value: 'writer', label: 'Writer', hint: 'Also edits.' },
  { value: 'maintainer', label: 'Maintainer', hint: 'Also settings.' },
];

const PROJECT = {
  id: 'p1',
  name: 'Lezgi',
  maintainers: ['me@example.com'],
  writers: ['ada@example.com'],
  readers: [],
  config: {},
};

const USERS = {
  'me@example.com': { id: 'me@example.com', displayName: 'Me', isAdmin: true },
  'ada@example.com': { id: 'ada@example.com', displayName: 'Ada', isAdmin: false },
};

const makeClient = () => ({
  users: { get: async (id) => USERS[id], avatarUrl: () => null },
  projects: {
    removeWriter: vi.fn(async () => {}),
    removeReader: vi.fn(async () => {}),
    removeMaintainer: vi.fn(async () => {}),
    addWriter: vi.fn(async () => {}),
    addReader: vi.fn(async () => {}),
    addMaintainer: vi.fn(async () => {}),
    setConfig: vi.fn(async () => {}),
  },
});

const mount = (props = {}) => {
  const client = props.client || makeClient();
  return renderComponent(
    <MemoryRouter>
      <ProjectMembers
        project={PROJECT}
        projectId="p1"
        currentUser={{ id: 'me@example.com', isAdmin: true }}
        onDataUpdate={props.onDataUpdate || (async () => {})}
        roleOptions={ROLE_OPTIONS}
        {...props}
        client={client}
      />
    </MemoryRouter>,
  ).then((view) => ({ ...view, client }));
};

const roleTriggers = (container) =>
  all(container, 'button[aria-label$="project role"]').map((b) => b.getAttribute('aria-label'));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('ProjectMembers', () => {
  it('resolves the ACL to people, alphabetically, and marks the admins', async () => {
    const { container, unmount } = await mount();
    // Each cell is the avatar's initial, then the display name, then the id.
    expect(texts(container, 'tbody tr td:first-child')).toEqual([
      'AAdaada@example.com',
      'MMeAdminme@example.com',
    ]);
    expect(roleTriggers(container)).toEqual(['Ada project role', 'Me project role']);
    await unmount();
  });

  it('will not let you change your own access, and says which row is yours', async () => {
    const { container, unmount } = await mount();
    const mine = all(container, 'tbody tr')[1];
    expect(mine.querySelector('button[aria-label="Me project role"]').disabled).toBe(true);
    expect(mine.textContent).toContain('Your own access');
    await unmount();
  });

  it('takes a role away before granting the next one, then refetches', async () => {
    const onDataUpdate = vi.fn(async () => {});
    const { client, unmount } = await mount({ onDataUpdate });
    const { setProjectRole } = await import('../../domain/projectRoles.js');

    await setProjectRole({
      client,
      project: PROJECT,
      projectId: 'p1',
      userId: 'ada@example.com',
      newRole: 'maintainer',
      currentUserId: 'me@example.com',
      onDataUpdate,
    });

    expect(client.projects.removeWriter).toHaveBeenCalledWith('p1', 'ada@example.com');
    expect(client.projects.addMaintainer).toHaveBeenCalledWith('p1', 'ada@example.com');
    const removedAt = client.projects.removeWriter.mock.invocationCallOrder[0];
    const addedAt = client.projects.addMaintainer.mock.invocationCallOrder[0];
    expect(removedAt).toBeLessThan(addedAt);
    expect(onDataUpdate).toHaveBeenCalled();
    await unmount();
  });

  it('refuses a role change aimed at the caller, wherever it comes from', async () => {
    const { client, unmount } = await mount();
    const { setProjectRole } = await import('../../domain/projectRoles.js');

    await setProjectRole({
      client,
      project: PROJECT,
      projectId: 'p1',
      userId: 'me@example.com',
      newRole: 'reader',
      currentUserId: 'me@example.com',
      onDataUpdate: async () => {},
    });

    expect(client.projects.removeMaintainer).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Cannot modify own permissions', {
      description: 'You cannot change your own role',
    });
    await unmount();
  });

  it('marks someone for review through the project config', async () => {
    const onDataUpdate = vi.fn(async () => {});
    const { container, client, step, unmount } = await mount({ onDataUpdate });

    const box = container.querySelector('input[aria-label="Review Ada\'s work"]');
    expect(box.checked).toBe(false);
    await step(async () => {
      box.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(client.projects.setConfig).toHaveBeenCalled();
    const [, ns, key, value] = client.projects.setConfig.mock.calls[0];
    expect(ns).toBe('plaid');
    expect(key).toBe('review');
    expect(JSON.stringify(value)).toContain('ada@example.com');
    expect(onDataUpdate).toHaveBeenCalled();
    await unmount();
  });

  it('cannot unmark someone whose whole role is reviewed', async () => {
    const project = { ...PROJECT, config: { plaid: { review: { roles: ['writer'] } } } };
    const { container, unmount } = await mount({ project });

    const box = container.querySelector('input[aria-label="Review Ada\'s work"]');
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(box.getAttribute('title')).toContain('Every writer is reviewed');
    await unmount();
  });
});
