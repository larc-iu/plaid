import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { renderComponent } from '../../test/renderComponent.jsx';

// The shell with its tab in `?tab=` (plaid-igt's documents). The tab a document
// opens on is a URL decision made partly by the app, and the ways it goes wrong
// are quiet. A landing that fires twice sends a reader who walked back to
// Details straight to the landing again. A landing that pushes instead of
// replacing makes Back undo the landing rather than leave the document. And a
// landing on a past state moves the reader off the tab their history click was
// about. The shell's other jobs are the same in both modes and are tested
// through plaid-ud's and plaid-umr's shells.

vi.mock('../../lib/integrityToast.js', () => ({
  reportIntegrityFindings: vi.fn(),
  dismissIntegrityFindings: vi.fn(),
}));
const auth = vi.hoisted(() => ({ getClient: vi.fn(), logout: vi.fn(), user: { id: 'u1' } }));
vi.mock('../../contexts/useAuth.js', () => ({ useAuth: () => auth }));
vi.mock('../../domain/useDocumentModel.js', () => ({ useDocumentModel: () => 0 }));
// The strip as data: which tab it marks, whether it is inert, and each tab's
// address.
vi.mock('./DocumentTabStrip.jsx', () => ({
  DocumentTabStrip: ({ tabs, active, disabled, project, failed }) => (
    <div
      data-testid="strip"
      data-active={active}
      data-disabled={String(disabled)}
      data-project={project?.name ?? ''}
      data-failed={String(!!failed)}
    >
      {tabs.map((t) => (
        <a key={t.value} data-testid={`to-${t.value}`} href={t.to}>
          {t.label}
        </a>
      ))}
    </div>
  ),
}));
const stores = vi.hoisted(() => ({ made: 0 }));
vi.mock('../../domain/CommentStore', () => ({
  CommentStore: class {
    constructor() {
      stores.made += 1;
    }
    load() {
      return Promise.resolve();
    }
  },
}));
vi.mock('../../domain/useCommentStore', () => ({ useCommentStore: () => 0 }));
const notify = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock('../../lib/notify.js', () => notify);
vi.mock('../../hooks/useWriteLock.js', () => ({
  useWriteLock: () => ({ held: null, acquire: () => null }),
}));
vi.mock('../../hooks/useResumedRun.js', () => ({ useResumedRun: () => {} }));
vi.mock('../assistant/useAssistantAvailable.js', () => ({ useAssistantAvailable: () => false }));
vi.mock('../assistant/subject.js', () => ({
  useAskAssistant: () => () => {},
  useAssistantSubject: () => {},
}));
const repair = vi.hoisted(() => ({ running: false }));
vi.mock('../../hooks/useReconcileOnOpen.js', () => ({
  useReconcileOnOpen: () => repair.running,
}));
const past = vi.hoisted(() => ({ asOf: null }));
vi.mock('../../hooks/useHistoryView.js', () => ({
  useHistoryView: () => ({
    drawerOpen: false,
    openHistory: () => {},
    closeHistory: () => {},
    selectedEntry: null,
    selectEntry: () => {},
    snapshot: null,
    asOf: past.asOf,
    isViewingHistorical: false,
    loadingSnapshot: false,
    auditEntries: [],
    loadingAudit: false,
    historyError: null,
    restoreEntry: null,
    setRestoreEntry: () => {},
    handleRestored: () => {},
  }),
}));

const { DocumentEditorShell } = await import('./DocumentEditorShell.jsx');

const tokenized = [{ tokens: [{ id: 't1' }] }];
const untokenized = [{ tokens: [] }];

// What the probes saw last, on a stable object.
const seen = {};

const Body = ({ tab, context }) => {
  seen.goToTab = context.goToTab;
  return <div data-testid="body">{tab}</div>;
};

const Where = () => {
  const { pathname, search } = useLocation();
  seen.navigate = useNavigate();
  seen.pathname = pathname;
  seen.search = search;
  return null;
};

const app = (over = {}) => ({
  loadDocument: async ({ documentId }) => ({
    raw: { id: documentId, name: 'Doc' },
    sentences: seen.sentences,
    hold: () => () => {},
    reload: () => Promise.resolve(),
  }),
  assistantApp: 'test',
  documentPath: (projectId, documentId) => `/p/${projectId}/d/${documentId}`,
  tabs: {
    list: [
      { value: 'baseline', label: 'Baseline' },
      { value: 'analyze', label: 'Analyze' },
      { value: 'comments', label: 'Comments' },
      { value: 'details', label: 'Details' },
    ],
    editor: 'analyze',
    past: ['baseline', 'analyze', 'details'],
    query: {
      fallback: 'baseline',
      landing: (doc) => (doc.sentences.some((s) => s.tokens.length) ? 'analyze' : null),
    },
  },
  renderTab: (tab, context) => <Body tab={tab} context={context} />,
  sentenceRef: (s, i) => `s${i + 1}`,
  ...over,
});

let view;

const mount = async (entries, { sentences = tokenized, config = app() } = {}) => {
  seen.sentences = sentences;
  view = await renderComponent(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Where />
      <Routes>
        <Route path="/p/:projectId" element={<div data-testid="project" />} />
        <Route path="/p/:projectId/d/:documentId" element={<DocumentEditorShell app={config} />} />
      </Routes>
    </MemoryRouter>,
  );
  await view.step(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const body = () => view.container.querySelector('[data-testid="body"]')?.textContent ?? null;
const strip = () => view.container.querySelector('[data-testid="strip"]');
const href = (value) =>
  view.container.querySelector(`[data-testid="to-${value}"]`)?.getAttribute('href');

beforeEach(() => {
  past.asOf = null;
  repair.running = false;
  auth.getClient.mockReturnValue({
    projects: { get: vi.fn(async () => ({ id: 'p1', name: 'Project' })) },
  });
});

describe('a document whose tab is in the query', () => {
  it('lands on the app’s tab when the address names none, and says so', async () => {
    await mount(['/p/p1/d/d1']);
    expect(body()).toBe('analyze');
    expect(seen.search).toBe('?tab=analyze');
    expect(strip().dataset.active).toBe('analyze');
    await view.unmount();
  });

  it('stays on the fallback when the app names no landing, and writes nothing', async () => {
    await mount(['/p/p1/d/d1'], { sentences: untokenized });
    expect(body()).toBe('baseline');
    expect(seen.search).toBe('');
    await view.unmount();
  });

  it('opens the fallback for a tab it does not know, and says the fallback', async () => {
    await mount(['/p/p1/d/d1?tab=bogus']);
    expect(body()).toBe('baseline');
    expect(seen.search).toBe('?tab=baseline');
    await view.unmount();
  });

  it('honours a tab the address asked for, the fallback among them', async () => {
    // A bare address means "no tab chosen", so `?tab=baseline` is the only way
    // to say Baseline and have it stay on a document that lands elsewhere.
    await mount(['/p/p1/d/d1?tab=baseline']);
    expect(body()).toBe('baseline');
    await view.step(() => seen.goToTab('analyze'));
    await view.step(() => seen.goToTab('baseline'));
    expect(seen.search).toBe('?tab=baseline');
    await view.unmount();
  });

  it('links every tab to its own address, keeping the rest of the query', async () => {
    await mount(['/p/p1/d/d1?tab=analyze&focusSentence=s3']);
    expect(href('baseline')).toBe('/p/p1/d/d1?tab=baseline&focusSentence=s3');
    expect(href('details')).toBe('/p/p1/d/d1?tab=details&focusSentence=s3');
    await view.unmount();
  });

  it('lands once, so walking to another tab sticks', async () => {
    await mount(['/p/p1/d/d1']);
    expect(body()).toBe('analyze');
    await view.step(() => seen.goToTab('details'));
    expect(body()).toBe('details');
    await view.step(() => seen.navigate('/p/p1/d/d1'));
    expect(body()).toBe('baseline');
    await view.unmount();
  });

  it('does not land while a past state is open', async () => {
    past.asOf = '2026-09-01T00:00:00Z';
    await mount(['/p/p1/d/d1']);
    expect(body()).toBe('baseline');
    await view.unmount();
  });

  it('leaves the document on Back instead of undoing the landing', async () => {
    await mount(['/p/p1', '/p/p1/d/d1']);
    expect(body()).toBe('analyze');
    await view.step(() => seen.navigate(-1));
    expect(seen.pathname).toBe('/p/p1');
    await view.unmount();
  });

  it('names the tab in the window title', async () => {
    await mount(['/p/p1/d/d1?tab=details']);
    expect(document.title.startsWith('Details · Doc · Project')).toBe(true);
    await view.unmount();
  });
});

describe('the repair on open', () => {
  it('holds the body and the tabs while the shell runs it', async () => {
    repair.running = true;
    await mount(['/p/p1/d/d1?tab=analyze'], { config: app({ reconcileOnOpen: true }) });
    expect(body()).toBe(null);
    expect(strip().dataset.disabled).toBe('true');
    await view.unmount();
  });

  it('holds nothing where the app runs it from a tab', async () => {
    repair.running = true;
    await mount(['/p/p1/d/d1?tab=analyze']);
    expect(body()).toBe('analyze');
    expect(strip().dataset.disabled).toBe('false');
    await view.unmount();
  });
});

describe('a document whose tab is in the path', () => {
  it('leaves a `?tab=` it does not own alone', async () => {
    const config = app({ tabs: { ...app().tabs, query: undefined }, renderTab: undefined });
    seen.sentences = tokenized;
    view = await renderComponent(
      <MemoryRouter initialEntries={['/p/p1/d/d1/analyze?tab=zzz']}>
        <Where />
        <Routes>
          <Route path="/p/:projectId/d/:documentId" element={<DocumentEditorShell app={config} />}>
            <Route path="analyze" element={<div data-testid="body">analyze</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await view.step(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(body()).toBe('analyze');
    expect(seen.search).toBe('?tab=zzz');
    expect(href('details')).toBe('/p/p1/d/d1/details');
    await view.unmount();
  });
});

describe('a document that fails to load', () => {
  const refused = (status) =>
    app({
      reconcileOnOpen: true,
      loadDocument: async () => {
        throw Object.assign(new Error(`HTTP ${status}`), { status });
      },
    });

  it('shows the error alone, under its project, with nothing loading and no toast', async () => {
    // The repair hook answers true until it has a document.
    repair.running = true;
    stores.made = 0;
    notify.notifyError.mockClear();
    await mount(['/p/p1/d/d1?tab=media'], { config: refused(403) });
    await view.step(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(view.container.textContent).not.toContain('Checking this document');
    expect(strip().dataset.disabled).toBe('false');
    expect(strip().dataset.project).toBe('Project');
    expect(strip().dataset.failed).toBe('true');
    expect(view.container.querySelector('[role="alert"]').textContent).toBe(
      'This document does not exist or you cannot open it.',
    );
    expect(body()).toBe(null);
    expect(stores.made).toBe(0);
    expect(notify.notifyError).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('says the same to an admin, whom core answers 404', async () => {
    await mount(['/p/p1/d/d1'], { config: refused(404) });
    await view.step(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(view.container.querySelector('[role="alert"]').textContent).toBe(
      'This document does not exist or you cannot open it.',
    );
    await view.unmount();
  });
});
