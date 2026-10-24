import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/notify.js', () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }));

import { notifyError, notifySuccess } from '../../lib/notify.js';
import { setProjectRoleNotifying, setProjectRoleReporting } from './reportRoleChange.js';

const project = { id: 'p', maintainers: ['me@x.com'], writers: [], readers: ['r@x.com'] };

const client = () => ({
  withOperation: async (_label, fn) => fn(() => {}),
  projects: {
    removeReader: vi.fn(async () => {}),
    addWriter: vi.fn(async () => {}),
  },
});

const args = (c, extra) => ({
  client: c,
  project,
  projectId: 'p',
  userId: 'r@x.com',
  newRole: 'writer',
  currentUserId: 'me@x.com',
  onDataUpdate: async () => {},
  ...extra,
});

beforeEach(() => {
  vi.mocked(notifyError).mockClear();
  vi.mocked(notifySuccess).mockClear();
});

describe('setProjectRoleNotifying', () => {
  it('says a change landed, and why one aimed at the caller was refused', async () => {
    await setProjectRoleNotifying(args(client()));
    expect(notifySuccess).toHaveBeenCalledWith('Permissions updated');
    await setProjectRoleNotifying(args(client(), { userId: 'me@x.com' }));
    expect(notifyError).toHaveBeenCalledWith('You cannot change your own role.');
  });
});

describe('setProjectRoleReporting', () => {
  it('says why a refused change failed, and reads the project again', async () => {
    const c = client();
    const refused = Object.assign(new Error('HTTP 403'), { status: 403 });
    c.projects.addWriter = vi.fn(async () => {
      throw refused;
    });
    const onDataUpdate = vi.fn(async () => {});
    await setProjectRoleReporting(args(c, { onDataUpdate }));
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyError).mock.calls[0][0]).toBe(refused);
    // The remove half landed, so the table must show the project as it is.
    expect(onDataUpdate).toHaveBeenCalled();
  });

  it('does not report a landed change as failed when only the refetch fails', async () => {
    const c = client();
    const onDataUpdate = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });
    await setProjectRoleReporting(args(c, { onDataUpdate }));
    expect(c.projects.addWriter).toHaveBeenCalled();
    expect(notifyError).not.toHaveBeenCalled();
    expect(notifySuccess).toHaveBeenCalled();
  });
});
