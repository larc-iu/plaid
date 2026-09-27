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

  // Pick a role in a row's Select, the way the keyboard does.
  const pickRole = async (step, container, name, label) => {
    const trigger = container.querySelector(`button[aria-label="${name} project role"]`);
    await step(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const option = [...document.querySelectorAll('[role="option"]')].find((o) =>
      o.textContent.trim().startsWith(label),
    );
    await step(async () => {
      option.focus();
      option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  it('shows a new role before the server has it, and takes it back with the reason when refused', async () => {
    const client = makeClient();
    let refuse;
    client.projects.addMaintainer = vi.fn(
      () =>
        new Promise((_, reject) => {
          refuse = () => reject(Object.assign(new Error('HTTP 403 Forbidden'), { status: 403 }));
        }),
    );
    const onDataUpdate = vi.fn(async () => {});
    const { container, step, unmount } = await mount({ client, onDataUpdate });
    await pickRole(step, container, 'Ada', 'Maintainer');
    const trigger = container.querySelector('button[aria-label="Ada project role"]');
    expect(trigger.textContent).toContain('Maintainer');
    await step(async () => {
      refuse();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(trigger.textContent).toContain('Writer');
    expect(toast.error).toHaveBeenCalledWith('Failed to update permissions', {
      description: "You don't have permission to do that.",
    });
    // The remove half may have landed: the project is read again.
    expect(onDataUpdate).toHaveBeenCalled();
    await unmount();
  });

  it('keeps a review mark that landed when the refetch after it fails, and says nothing', async () => {
    const onDataUpdate = vi.fn(async () => {
      throw new Error('Network error: Failed to fetch');
    });
    const { container, step, unmount } = await mount({ onDataUpdate });
    const box = container.querySelector('input[aria-label="Review Ada\'s work"]');
    await step(async () => {
      box.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(box.checked).toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
    await unmount();
  });

  it('shows a review mark at once, and takes it back with the reason when refused', async () => {
    const client = makeClient();
    let refuse;
    client.projects.setConfig = vi.fn(
      () => new Promise((_, reject) => (refuse = () => reject(new Error('HTTP 500 boom')))),
    );
    const { container, step, unmount } = await mount({ client });
    const box = container.querySelector('input[aria-label="Review Ada\'s work"]');
    await step(async () => {
      box.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(box.checked).toBe(true);
    await step(async () => {
      refuse();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(box.checked).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('Failed to update review', {
      description: 'The server hit an unexpected error. Try again in a moment.',
    });
    await unmount();
  });

  it('sends each review mark with the ones still shown, and not one that was refused', async () => {
    const project = { ...PROJECT, writers: ['ada@example.com', 'bo@example.com'] };
    USERS['bo@example.com'] = { id: 'bo@example.com', displayName: 'Bo', isAdmin: false };
    const client = makeClient();
    const sent = [];
    let first = true;
    client.projects.setConfig = vi.fn(async (_p, _ns, _key, value) => {
      sent.push(value);
      if (first) {
        first = false;
        throw new Error('HTTP 500 boom');
      }
    });
    const { container, step, unmount } = await mount({ client, project });
    await step(async () => {
      container.querySelector('input[aria-label="Review Ada\'s work"]').click();
      container.querySelector('input[aria-label="Review Bo\'s work"]').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[0])).toContain('ada@example.com');
    expect(JSON.stringify(sent[1])).toContain('bo@example.com');
    expect(JSON.stringify(sent[1])).not.toContain('ada@example.com');
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
