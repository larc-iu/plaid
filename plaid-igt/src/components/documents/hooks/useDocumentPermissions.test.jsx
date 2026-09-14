import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// The document editor used to answer this itself, off the project's three ACL
// arrays, and it disagreed with every other screen at one end: a user in none
// of the arrays came back `isReadOnly: false`, so the editor rendered as
// editable for someone with no access at all.

const auth = { user: null };
vi.mock('../../../contexts/AuthContext.jsx', () => ({ useAuth: () => auth }));

const { useDocumentPermissions } = await import('./useDocumentPermissions.js');

const project = { maintainers: ['m'], writers: ['w'], readers: ['r'] };

let seen;
const Probe = ({ projectData }) => {
  seen = useDocumentPermissions(projectData);
  return null;
};

const ask = async (user, projectData = project) => {
  auth.user = user;
  const view = await renderComponent(<Probe projectData={projectData} />);
  await view.unmount();
  return seen;
};

beforeEach(() => {
  auth.user = null;
});

describe('what this reader may do with a document', () => {
  it('gives a maintainer everything', async () => {
    expect(await ask({ id: 'm' })).toEqual({
      canRead: true,
      canWrite: true,
      canManage: true,
      isReadOnly: false,
    });
  });

  it('lets a writer write but not manage', async () => {
    expect(await ask({ id: 'w' })).toEqual({
      canRead: true,
      canWrite: true,
      canManage: false,
      isReadOnly: false,
    });
  });

  it('puts a reader in read-only', async () => {
    expect(await ask({ id: 'r' })).toEqual({
      canRead: true,
      canWrite: false,
      canManage: false,
      isReadOnly: true,
    });
  });

  it('puts someone with no access in read-only too', async () => {
    expect(await ask({ id: 'x' })).toEqual({
      canRead: false,
      canWrite: false,
      canManage: false,
      isReadOnly: true,
    });
  });

  it('gives an admin everything without being listed', async () => {
    expect(await ask({ id: 'x', isAdmin: true })).toEqual({
      canRead: true,
      canWrite: true,
      canManage: true,
      isReadOnly: false,
    });
  });

  it('refuses everything while the document has no project yet', async () => {
    expect(await ask({ id: 'm' }, null)).toEqual({
      canRead: false,
      canWrite: false,
      canManage: false,
      isReadOnly: true,
    });
  });

  it('refuses an admin too while the document has no project yet', async () => {
    // An admin needs no ACL entry, so every test in permissions.js passes on
    // the user alone and the answer for a project that has not loaded is the
    // same all-true answer as for one that has. A member cannot see this.
    expect(await ask({ id: 'x', isAdmin: true }, null)).toEqual({
      canRead: false,
      canWrite: false,
      canManage: false,
      isReadOnly: true,
    });
  });

  it('refuses everything with nobody signed in', async () => {
    expect(await ask(null)).toEqual({
      canRead: false,
      canWrite: false,
      canManage: false,
      isReadOnly: true,
    });
  });
});
