import { describe, it, expect, vi } from 'vitest';
import { setProjectRole } from './projectRoles.js';

const project = { id: 'p', maintainers: ['me@x.com'], writers: [], readers: ['r@x.com'] };

// Records each write, and the label of the operation it ran under.
const client = () => {
  const calls = [];
  let open = null;
  const write = (name) =>
    vi.fn(async (...args) => {
      calls.push({ name, args, operation: open });
    });
  return {
    calls,
    withOperation: vi.fn(async (label, fn) => {
      open = label;
      try {
        return await fn(() => {});
      } finally {
        open = null;
      }
    }),
    projects: {
      removeReader: write('removeReader'),
      addWriter: write('addWriter'),
      removeWriter: write('removeWriter'),
      addMaintainer: write('addMaintainer'),
    },
  };
};

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

describe('setProjectRole', () => {
  it('makes the remove and the add one labelled operation', async () => {
    const c = client();
    const result = await setProjectRole(args(c));
    expect(result).toEqual({ changed: true });
    expect(c.withOperation).toHaveBeenCalledTimes(1);
    expect(c.calls.map((w) => w.name)).toEqual(['removeReader', 'addWriter']);
    const [label] = c.withOperation.mock.calls[0];
    expect(label).toBe('Make r@x.com a writer');
    expect(c.calls.every((w) => w.operation === label)).toBe(true);
  });

  it('names a removal from the project as one', async () => {
    const c = client();
    await setProjectRole(args(c, { newRole: 'none' }));
    expect(c.withOperation.mock.calls[0][0]).toBe('Remove r@x.com from the project');
    expect(c.calls.map((w) => w.name)).toEqual(['removeReader']);
  });

  it('refuses the caller their own role, saying so to the screen rather than toasting', async () => {
    const c = client();
    const result = await setProjectRole(args(c, { userId: 'me@x.com' }));
    expect(result).toEqual({ changed: false, refused: 'You cannot change your own role.' });
    expect(c.calls).toEqual([]);
  });

  it('writes nothing for the role someone already has', async () => {
    const c = client();
    expect(await setProjectRole(args(c, { newRole: 'reader' }))).toEqual({ changed: false });
    expect(c.calls).toEqual([]);
  });
});
