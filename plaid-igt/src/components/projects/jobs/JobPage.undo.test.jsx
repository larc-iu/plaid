import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';

// Undo job on an ended job's page: for a maintainer of the project, one
// button for the whole job, its documents and its lexicon changes together,
// through the Undo dialog (a dry run first), and after it a line that says
// the job was undone, with a link to the undo in History.

const auth = vi.hoisted(() => ({ user: { id: 'm', isAdmin: false } }));
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => auth }));
const feedback = vi.hoisted(() => ({
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
  notifyInfo: vi.fn(),
  notifyWarning: vi.fn(),
}));
vi.mock('@/utils/feedback', () => feedback);
const { JobPage } = await import('./JobPage.jsx');

const PROJECT = {
  id: 'p1',
  maintainers: ['m'],
  writers: ['w'],
  readers: ['r'],
  vocabs: [{ id: 'v1', name: 'Story lexicon' }],
};

const jobOf = (over = {}) => ({
  id: 'j1',
  project: 'p1',
  app: 'igt',
  instructions: 'Gloss every word.',
  startedBy: 'w',
  startedByName: 'Wren',
  state: 'done',
  phase: null,
  reason: null,
  message: null,
  createdAt: '2026-11-12T10:00:00Z',
  startedAt: '2026-11-12T10:01:00Z',
  finishedAt: '2026-11-12T10:30:00Z',
  documents: [
    { documentId: 'd1', name: 'Story one', position: 0, state: 'done', counts: {}, skipped: [] },
    { documentId: 'd2', name: 'Story two', position: 1, state: 'done', counts: {}, skipped: [] },
  ],
  report: null,
  ...over,
});

const counts = (n, how = 'updated') => ({ inserted: 0, updated: 0, deleted: 0, [how]: n });
const SUMMARY = {
  entries: ['g1', 'g2'],
  dryRun: true,
  undone: {
    spans: counts(4),
    vocabLinks: counts(2, 'deleted'),
    vocabItems: counts(1, 'deleted'),
  },
  total: 7,
  rows: 9,
  skipped: [
    { kind: 'span', id: 's1', document: 'd2', reason: 'changed-since' },
    { kind: 'span', id: 's2', document: 'd1', reason: 'changed-since' },
    { kind: 'vocab-link', id: 'l1', document: 'd1', reason: 'changed-since' },
  ],
  skippedCount: 3,
  notUndone: [],
};

const clientOf = (job, undo = vi.fn(async () => SUMMARY)) => ({
  jobs: { get: vi.fn(async () => job), cancel: vi.fn(), undo },
  documents: {
    auditPage: vi.fn(async (documentId, { entryId }) => ({
      entries: documentId === 'd2' ? [{ id: entryId, partOf: 'b1', ops: [] }] : [],
    })),
  },
  messages: { discoverServices: vi.fn(async () => []) },
});

const settle = (v) =>
  v.step(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });

const mount = async (client) => {
  const v = await renderComponent(
    <MemoryRouter>
      <ConfirmProvider>
        <JobPage project={PROJECT} projectId="p1" jobId="j1" client={client} />
      </ConfirmProvider>
    </MemoryRouter>,
  );
  await settle(v);
  return v;
};

const button = (root, label) =>
  all(root, 'button').find((b) => b.textContent.trim() === label) ?? null;
const press = (v, el) =>
  v.step(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
const dialog = () => document.body.querySelector('[data-testid="undo-dialog"]');

beforeEach(() => {
  auth.user = { id: 'm', isAdmin: false };
  for (const f of Object.values(feedback)) f.mockReset();
});

describe('Undo job', () => {
  it('is offered on an ended job to a maintainer and an admin only', async () => {
    const who = [
      [{ id: 'm', isAdmin: false }, true],
      [{ id: 'a', isAdmin: true }, true],
      [{ id: 'w', isAdmin: false }, false],
      [{ id: 'r', isAdmin: false }, false],
    ];
    for (const [user, shown] of who) {
      auth.user = user;
      const v = await mount(clientOf(jobOf()));
      expect(!!button(v.container, 'Undo job')).toBe(shown);
      await v.unmount();
    }
    auth.user = { id: 'm', isAdmin: false };
    for (const state of ['done', 'cancelled', 'failed']) {
      const v = await mount(clientOf(jobOf({ state })));
      expect(button(v.container, 'Undo job')).not.toBeNull();
      await v.unmount();
    }
    for (const state of ['waiting', 'running', 'stopping']) {
      const v = await mount(clientOf(jobOf({ state, finishedAt: null })));
      expect(button(v.container, 'Undo job')).toBeNull();
      await v.unmount();
    }
  });

  it('shows the dry run over every document, then the lexicon, and undoes the job', async () => {
    const undo = vi
      .fn()
      .mockResolvedValueOnce(SUMMARY)
      .mockResolvedValueOnce({ ...SUMMARY, dryRun: false, operation: 'o1' });
    const client = clientOf(jobOf(), undo);
    const v = await mount(client);
    await press(v, button(v.container, 'Undo job'));
    await settle(v);
    expect(client.jobs.undo).toHaveBeenCalledWith('j1', { dryRun: true });
    expect(dialog().querySelector('h2').textContent).toBe('Undo this job?');
    expect(dialog().querySelector('[data-testid="undo-line"]').textContent).toBe(
      '4 values, 2 links and 1 lexicon entry removed',
    );
    // Left rows by document, in the job's order.
    const places = all(dialog(), '[data-place]').map((p) => [
      p.querySelector('a')?.textContent,
      p.querySelector('a')?.getAttribute('href'),
      p.lastElementChild.textContent,
    ]);
    expect(places).toEqual([
      ['Story one', '/projects/p1/documents/d1', '2 changes'],
      ['Story two', '/projects/p1/documents/d2', '1 change'],
    ]);
    // No lexicon note: the job's undo takes the lexicon part too.
    expect(dialog().querySelector('[data-testid="undo-entries-note"]')).toBeNull();

    await press(v, button(dialog(), 'Undo'));
    await settle(v);
    expect(client.jobs.undo).toHaveBeenLastCalledWith('j1', { dryRun: false });
    expect(feedback.notifySuccess).toHaveBeenCalledWith(
      '4 values, 2 links and 1 lexicon entry removed. 3 changes left as they were.',
      'Undone',
    );
    const line = v.container.querySelector('[data-testid="job-undone"]');
    expect(line.textContent).toMatch(/^Job undone .+\. Show in History$/);
    expect(client.documents.auditPage).toHaveBeenCalledWith('d1', { entryId: 'o1', opsLimit: 1 });
    expect(line.querySelector('a').getAttribute('href')).toBe(
      '/projects/p1/documents/d2?history=b1',
    );
    expect(button(v.container, 'Undo job')).toBeNull();
    await v.unmount();
  });

  it('says how many changes a job too large made, and where it is undone instead', async () => {
    const big = Object.assign(new Error('HTTP 413 x at http://x/y'), {
      status: 413,
      responseData: { error: 'This entry changed 25550 rows. An undo takes at most 20000.' },
    });
    const v = await mount(clientOf(jobOf(), vi.fn().mockRejectedValue(big)));
    await press(v, button(v.container, 'Undo job'));
    await settle(v);
    expect(dialog().textContent).toContain(
      'This job made 25,550 changes. An undo takes at most 20,000, so this job is undone document by document, from each document’s Changes link on this page.',
    );
    expect(button(dialog(), 'Undo')).toBeNull();
    await v.unmount();
  });

  it('says nothing was undone, and not that the job was, when the call undid nothing', async () => {
    const undo = vi
      .fn()
      .mockResolvedValueOnce(SUMMARY)
      .mockResolvedValueOnce({ ...SUMMARY, undone: {}, total: 0, dryRun: false });
    const v = await mount(clientOf(jobOf(), undo));
    await press(v, button(v.container, 'Undo job'));
    await settle(v);
    await press(v, button(dialog(), 'Undo'));
    await settle(v);
    expect(feedback.notifyInfo).toHaveBeenCalledWith(
      '3 changes left as they were.',
      'Nothing undone',
    );
    expect(v.container.querySelector('[data-testid="job-undone"]')).toBeNull();
    await v.unmount();
  });
});
