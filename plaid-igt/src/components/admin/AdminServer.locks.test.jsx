import { afterEach, describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// Open documents name what is open and who holds it, and lead to it: a project
// in the app that owns it, a document only in this app's own projects. A
// sign-in row's Clear also clears its address's own failures, and the toast
// says so.

const feedback = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));
vi.mock('@/utils/feedback', async () => {
  const errors = await import('@ui/lib/errors.js');
  return { ...feedback, humanizeError: errors.humanizeError };
});
vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => async () => true }));

const { AdminServer } = await import('./AdminServer.jsx');

const report = {
  version: '1',
  jvm: {},
  database: {},
  media: { files: 0, bytes: 0 },
  settings: {},
  backup: { enabled: false, retention: 7, time: '03:00', directory: '/b', backups: [] },
};

const igtProject = { id: 'p-igt', name: 'Glosses', config: { igt: { initialized: true } } };
const udProject = {
  id: 'p-ud',
  name: 'Treebank',
  config: {},
  textLayers: [
    {
      config: { plaid: { role: 'baseline' } },
      tokenLayers: [
        {
          config: { plaid: { role: 'syntactic-word' } },
          spanLayers: [{ config: { ud: { upos: true } } }],
        },
      ],
    },
  ],
};

const lock = (over) => ({
  documentId: 'd-1',
  documentName: 'Story one',
  projectId: 'p-igt',
  projectName: 'Glosses',
  userId: 'ana@example.com',
  userName: 'Ana',
  expiresAt: Date.now() + 45000,
  ...over,
});

const clientWith = ({ locks = [], rateLimits = { logins: [], ips: [], invites: [] } } = {}) => ({
  admin: {
    server: vi.fn(async () => report),
    locks: vi.fn(async () => ({ entries: locks })),
    rateLimits: vi.fn(async () => rateLimits),
    clearRateLimits: vi.fn(async () => ({ result: 'cleared' })),
  },
  projects: { list: vi.fn(async () => [igtProject, udProject]) },
});

const show = async (client) => {
  const view = await renderComponent(
    <MemoryRouter>
      <AdminServer client={client} />
    </MemoryRouter>,
  );
  await view.step(async () => {});
  return view;
};

const anchor = (text) => all(document.body, 'a').find((a) => a.textContent === text);

afterEach(() => vi.clearAllMocks());

describe('Open documents', () => {
  it('names the document, its project and its holder, with when the lock expires', async () => {
    const view = await show(clientWith({ locks: [lock()] }));
    const row = [...document.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent.includes('Story one'),
    );
    expect(row).toBeTruthy();
    expect(row.textContent).toContain('Glosses');
    expect(row.textContent).toContain('Ana');
    expect(row.textContent).not.toContain('d-1');
    expect(row.textContent).toMatch(/in \d+ seconds/);
    await view.unmount();
  });

  it("links an igt project's document and project inside this app", async () => {
    const view = await show(clientWith({ locks: [lock()] }));
    expect(anchor('Story one').getAttribute('href')).toBe('/projects/p-igt/documents/d-1');
    expect(anchor('Glosses').getAttribute('href')).toBe('/projects/p-igt');
    await view.unmount();
  });

  it("links another app's project to that app, and its document to nothing", async () => {
    const view = await show(
      clientWith({
        locks: [lock({ projectId: 'p-ud', projectName: 'Treebank', documentName: 'Sent 1' })],
      }),
    );
    expect(anchor('Treebank').getAttribute('href')).not.toMatch(/^\/projects\//);
    expect(anchor('Treebank').getAttribute('href')).toContain('p-ud');
    expect(anchor('Sent 1')).toBeUndefined();
    await view.unmount();
  });

  it('reads the projects only when a document is open', async () => {
    const client = clientWith();
    const view = await show(client);
    expect(client.projects.list).not.toHaveBeenCalled();
    await view.unmount();
  });
});
