import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent, all, byText } from '../../test/renderComponent.jsx';

// An assistant job (the jobs round, 2026-11-12, SPEC 11.3) working in the open
// document shows the run banner, in every app: the shell reads the project's
// active job and draws it on the document the job is in, and nowhere else.
// Stop there stops the whole job, after asking. A job holds no write lock, so
// the document stays editable and the banner says nothing about editing. A
// run's own banner, when there is one, comes first.

vi.mock('../../lib/integrityToast.js', () => ({
  reportIntegrityFindings: vi.fn(),
  dismissIntegrityFindings: vi.fn(),
}));
const auth = vi.hoisted(() => ({ getClient: vi.fn(), logout: vi.fn(), user: { id: 'w' } }));
vi.mock('../../contexts/useAuth.js', () => ({ useAuth: () => auth }));
vi.mock('../../domain/useDocumentModel.js', () => ({ useDocumentModel: () => 0 }));
// The strip as its actions, which is where the app's header actions go.
vi.mock('./DocumentTabStrip.jsx', () => ({
  DocumentTabStrip: ({ actions }) => <div data-testid="strip">{actions}</div>,
}));
vi.mock('../../domain/CommentStore', () => ({
  CommentStore: class {
    load() {
      return Promise.resolve();
    }
  },
}));
vi.mock('../../domain/useCommentStore', () => ({ useCommentStore: () => 0 }));
const notify = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock('../../lib/notify.js', () => notify);
const lock = vi.hoisted(() => ({ held: null }));
vi.mock('../../hooks/useWriteLock.js', () => ({
  useWriteLock: () => ({ held: lock.held, acquire: () => null }),
}));
vi.mock('../../hooks/useResumedRun.js', () => ({ useResumedRun: () => {} }));
vi.mock('../assistant/useAssistantAvailable.js', () => ({ useAssistantAvailable: () => false }));
vi.mock('../assistant/subject.js', () => ({
  useAskAssistant: () => () => {},
  useAssistantSubject: () => {},
}));
vi.mock('../../hooks/useValidateOnOpen.js', () => ({ useValidateOnOpen: () => {} }));
const confirm = vi.hoisted(() => ({ fn: null }));
vi.mock('./ConfirmProvider.jsx', () => ({ useConfirm: () => confirm.fn }));

const { DocumentEditorShell } = await import('./DocumentEditorShell.jsx');

const project = { id: 'p1', name: 'Project', maintainers: ['m'], writers: ['w', 'w2'] };

const runningJob = (over = {}) => ({
  id: 'j1',
  state: 'running',
  startedBy: 'w',
  currentDocument: 'd1',
  message: 'Sentences 11 to 15 of 40.',
  startedAt: new Date().toISOString(),
  documents: [
    { documentId: 'd1', position: 0, state: 'working', targets: 20, done: 5 },
    { documentId: 'd2', position: 1, state: 'waiting', targets: null, done: null },
  ],
  ...over,
});

const app = (over = {}) => ({
  loadDocument: async ({ documentId }) => ({
    raw: { id: documentId, name: 'Doc' },
    sentences: [],
    hold: () => () => {},
    reload: () => Promise.resolve(),
  }),
  assistantApp: 'test',
  documentPath: (projectId, documentId) => `/p/${projectId}/d/${documentId}`,
  tabs: {
    list: [{ value: 'analyze', label: 'Analyze' }],
    editor: 'analyze',
    past: ['analyze'],
    query: { fallback: 'analyze' },
  },
  renderTab: () => <div data-testid="body" />,
  sentenceRef: (s, i) => `s${i + 1}`,
  ...over,
});

let view;
let client;

const settle = () =>
  view.step(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

const mount = async (documentId = 'd1', config = app()) => {
  view = await renderComponent(
    <MemoryRouter initialEntries={[`/p/p1/d/${documentId}`]}>
      <Routes>
        <Route path="/p/:projectId/d/:documentId" element={<DocumentEditorShell app={config} />} />
      </Routes>
    </MemoryRouter>,
  );
  await settle();
};

const banners = () => all(view.container, '[data-run-banner]');
const stopButton = () =>
  all(view.container, '[data-run-banner] button').find((b) => b.textContent === 'Stop');

beforeEach(() => {
  lock.held = null;
  auth.user = { id: 'w' };
  confirm.fn = vi.fn(async () => true);
  notify.notifyError.mockReset();
  client = {
    projects: { get: vi.fn(async () => project) },
    jobs: {
      active: vi.fn(async () => runningJob()),
      cancel: vi.fn(async () => runningJob({ state: 'stopping' })),
    },
  };
  auth.getClient.mockReturnValue(client);
});

describe('the job banner', () => {
  it('shows on the document the job is working in', async () => {
    await mount('d1');
    expect(client.jobs.active).toHaveBeenCalledWith('p1');
    expect(banners()).toHaveLength(1);
    const banner = banners()[0];
    expect(banner.textContent).toContain('Assistant job');
    expect(banner.textContent).toContain('Sentences 11 to 15 of 40.');
    // A job holds no write lock: the document stays editable.
    expect(banner.textContent).not.toContain('Editing paused.');
    expect(banner.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('25');
    await view.unmount();
  });

  it('does not show on another document of the job', async () => {
    await mount('d2');
    expect(client.jobs.active).toHaveBeenCalledWith('p1');
    expect(banners()).toHaveLength(0);
    await view.unmount();
  });

  it('does not show while the job waits, or when the project has none', async () => {
    client.jobs.active.mockResolvedValue(runningJob({ state: 'waiting' }));
    await mount('d1');
    expect(banners()).toHaveLength(0);
    await view.unmount();
    client.jobs.active.mockResolvedValue(null);
    await mount('d1');
    expect(banners()).toHaveLength(0);
    await view.unmount();
  });

  it('asks before Stop, and stops the job only on yes', async () => {
    await mount('d1');
    confirm.fn.mockResolvedValueOnce(false);
    await view.step(() => stopButton().click());
    await settle();
    expect(confirm.fn).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Stop the job?', description: 'What it wrote stays.' }),
    );
    expect(client.jobs.cancel).not.toHaveBeenCalled();

    const reads = client.jobs.active.mock.calls.length;
    await view.step(() => stopButton().click());
    await settle();
    expect(client.jobs.cancel).toHaveBeenCalledWith('j1');
    // Read again at once, so the banner follows the job to its end.
    expect(client.jobs.active.mock.calls.length).toBe(reads + 1);
    await view.unmount();
  });

  it('says a Stop that was refused', async () => {
    const refused = Object.assign(new Error('This job has ended.'), { status: 409 });
    client.jobs.cancel.mockRejectedValueOnce(refused);
    await mount('d1');
    await view.step(() => stopButton().click());
    await settle();
    expect(notify.notifyError).toHaveBeenCalledWith(refused, 'Failed to stop the job');
    await view.unmount();
  });

  it('offers Stop to whoever may stop the job, and to nobody else', async () => {
    auth.user = { id: 'w2' };
    await mount('d1');
    expect(banners()).toHaveLength(1);
    expect(stopButton()).toBeUndefined();
    await view.unmount();

    auth.user = { id: 'm' };
    await mount('d1');
    expect(stopButton()).toBeDefined();
    await view.unmount();
  });

  it('comes after a run’s banner when both show', async () => {
    lock.held = { label: 'Tokenize', startedAt: Date.now(), steps: ['Tokenize'], stepIndex: 0 };
    await mount('d1');
    expect(banners().map((b) => b.querySelector('p').textContent)).toEqual([
      'Tokenize',
      'Assistant job',
    ]);
    await view.unmount();
  });
});

describe('the app’s header actions', () => {
  it('are drawn beside History, given the page’s context', async () => {
    const headerActions = vi.fn((context) => (
      <button type="button" data-testid="start">
        Start job {context.documentId}
      </button>
    ));
    await mount('d1', app({ headerActions }));
    const strip = view.container.querySelector('[data-testid="strip"]');
    const buttons = all(strip, 'button').map((b) => b.textContent.trim());
    expect(buttons).toEqual(['Start job d1', 'History']);
    expect(headerActions).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: 'p1', documentId: 'd1', project }),
    );
    expect(byText(strip, 'button', 'History')).not.toBe(null);
    await view.unmount();
  });
});
