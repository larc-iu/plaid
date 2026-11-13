import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { renderComponent } from '../../test/renderComponent.jsx';

// The History entry open, in the address. A job's page links to its entry in
// each document, so `?history=<entry>` has to open the rail and that entry,
// Back has to leave it, and an entry left on its own (a restore, the rail
// closed) must not leave the address naming it, or the next render opens it
// again. Where the app has a view of what an entry changed, a whole entry
// opens on it, and the line over it switches to the document as of the entry.

vi.mock('../../lib/integrityToast.js', () => ({
  reportIntegrityFindings: vi.fn(),
  dismissIntegrityFindings: vi.fn(),
}));
const auth = vi.hoisted(() => ({ getClient: vi.fn(), logout: vi.fn(), user: { id: 'u1' } }));
vi.mock('../../contexts/useAuth.js', () => ({ useAuth: () => auth }));
vi.mock('../../domain/useDocumentModel.js', () => ({ useDocumentModel: () => 0 }));
vi.mock('./DocumentTabStrip.jsx', () => ({
  DocumentTabStrip: (props) => {
    seen.strip = props;
    return null;
  },
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
vi.mock('../../hooks/useWriteLock.js', () => ({
  useWriteLock: () => ({ held: null, acquire: () => null }),
}));
vi.mock('../../hooks/useResumedRun.js', () => ({ useResumedRun: () => {} }));
vi.mock('../assistant/useAssistantAvailable.js', () => ({ useAssistantAvailable: () => false }));
vi.mock('../assistant/subject.js', () => ({
  useAskAssistant: () => () => {},
  useAssistantSubject: () => {},
}));
vi.mock('../../hooks/useValidateOnOpen.js', () => ({ useValidateOnOpen: () => {} }));

const seen = vi.hoisted(() => ({}));
// The panel as the shell hands it over: what a pick in the rail calls.
vi.mock('./DocumentHistoryPanel.jsx', () => ({
  DocumentHistoryPanel: (props) => {
    seen.panel = props;
    return <div data-testid="drawer" data-open={String(props.history.drawerOpen)} />;
  },
}));
// Time travel as a little state machine: a pick selects at once, and the
// snapshot is the document as of the entry's time.
vi.mock('../../hooks/useHistoryView.js', async () => {
  const { useState } = await import('react');
  return {
    useHistoryView: () => {
      const [selected, setSelected] = useState(null);
      const [open, setOpen] = useState(false);
      seen.leave = () => setSelected(null);
      return {
        drawerOpen: open,
        openHistory: () => setOpen(true),
        closeHistory: () => {
          setOpen(false);
          setSelected(null);
        },
        selectedEntry: selected,
        selectEntry: async (entry) => setSelected(entry),
        snapshot: selected ? { asOf: selected.time, raw: { name: 'Doc then' } } : null,
        asOf: selected?.time ?? null,
        isViewingHistorical: !!selected,
        loadingSnapshot: false,
        auditEntries: [],
        loadingAudit: false,
        historyError: null,
        restoreEntry: null,
        setRestoreEntry: () => {},
        handleRestored: () => {},
      };
    },
  };
});

const { DocumentEditorShell } = await import('./DocumentEditorShell.jsx');

const Where = () => {
  const { search } = useLocation();
  seen.search = search;
  seen.navigate = useNavigate();
  return null;
};

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
    list: [
      { value: 'baseline', label: 'Baseline' },
      { value: 'analyze', label: 'Analyze' },
    ],
    editor: 'analyze',
    past: ['baseline', 'analyze'],
    query: { fallback: 'baseline', landing: () => null },
  },
  renderTab: (tab, context) => (
    <div data-testid="body" data-name={context.doc?.raw?.name}>
      {tab}
    </div>
  ),
  historyChanges: (context) => (
    <div
      data-testid="changes"
      data-entry={context.pastEntry.id}
      data-snapshot={context.historySnapshot?.raw?.name ?? ''}
    />
  ),
  sentenceRef: (s, i) => `s${i + 1}`,
  ...over,
});

let view;
let auditPage;

const settle = () =>
  view.step(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });

const mount = async (url, config = app()) => {
  view = await renderComponent(
    <MemoryRouter initialEntries={[url]}>
      <Where />
      <Routes>
        <Route path="/p/:projectId/d/:documentId" element={<DocumentEditorShell app={config} />} />
      </Routes>
    </MemoryRouter>,
  );
  await settle();
};

const q = () => new URLSearchParams(seen.search);
const changes = () => view.container.querySelector('[data-testid="changes"]');
const body = () => view.container.querySelector('[data-testid="body"]');
const switchTo = (label) =>
  [...view.container.querySelectorAll('[role="group"] button')].find(
    (b) => b.textContent === label,
  );

beforeEach(() => {
  notify.notifyError.mockReset();
  auditPage = vi.fn(async (documentId, { entryId }) => ({
    entries:
      entryId === 'g1'
        ? [{ id: 'g1', time: '2026-11-01T00:00:00Z', endTime: '2026-11-01T00:05:00Z', ops: [] }]
        : [],
    nextCursor: null,
  }));
  auth.getClient.mockReturnValue({
    projects: { get: vi.fn(async () => ({ id: 'p1', name: 'Project' })) },
    documents: { auditPage },
  });
});

describe('a History entry in the address', () => {
  it('opens the rail and the entry a link names, on what it changed', async () => {
    await mount('/p/p1/d/d1?tab=analyze&history=g1');
    expect(auditPage).toHaveBeenCalledWith('d1', { entryId: 'g1', opsLimit: 1 });
    expect(view.container.querySelector('[data-testid="drawer"]').dataset.open).toBe('true');
    expect(changes().dataset.entry).toBe('g1');
    // The document after the whole entry, which the view places its rows in.
    expect(changes().dataset.snapshot).toBe('Doc then');
    expect(body()).toBeNull();
    expect(view.container.textContent).toContain('Changes made in this entry');
    await view.unmount();
  });

  it('switches to the document as of the entry and back, in the address', async () => {
    await mount('/p/p1/d/d1?tab=analyze&history=g1');
    await view.step(() => switchTo('Document').click());
    expect(q().get('historyView')).toBe('document');
    expect(changes()).toBeNull();
    expect(body().dataset.name).toBe('Doc then');
    expect(view.container.textContent).toContain('This is the document as of');
    await view.step(() => switchTo('Changes').click());
    expect(q().get('historyView')).toBeNull();
    expect(changes()).not.toBeNull();
    await view.unmount();
  });

  it('names a pick in the rail, and Back leaves it', async () => {
    await mount('/p/p1/d/d1?tab=analyze');
    await view.step(() =>
      seen.panel.history.selectEntry({ id: 'u2', time: '2026-11-02T00:00:00Z' }),
    );
    expect(q().get('history')).toBe('u2');
    expect(changes().dataset.entry).toBe('u2');
    // Picked in the rail, so read from nothing: the rail had its time.
    expect(auditPage).not.toHaveBeenCalled();
    await view.step(() => seen.navigate(-1));
    await settle();
    expect(q().get('history')).toBeNull();
    expect(changes()).toBeNull();
    expect(body().textContent).toBe('analyze');
    await view.unmount();
  });

  it('opens an action inside an entry on what it changed, and its address again on reload', async () => {
    await mount('/p/p1/d/d1?tab=analyze');
    await view.step(() =>
      seen.panel.history.selectEntry({ id: 'op-1', time: '2026-11-02T00:00:00Z' }),
    );
    expect(q().get('history')).toBe('op-1');
    expect(changes().dataset.entry).toBe('op-1');
    expect(switchTo('Document')).not.toBeUndefined();
    await view.unmount();
    // The address alone, as a reload or Back gives it: core reads an
    // action's id as an entry of that one action.
    auditPage.mockImplementation(async (documentId, { entryId }) => ({
      entries:
        entryId === 'op-1'
          ? [{ id: 'op-1', time: '2026-11-02T00:00:00Z', endTime: '2026-11-02T00:00:01Z', ops: [] }]
          : [],
      nextCursor: null,
    }));
    await mount('/p/p1/d/d1?tab=analyze&history=op-1');
    expect(auditPage).toHaveBeenCalledWith('d1', { entryId: 'op-1', opsLimit: 1 });
    expect(notify.notifyError).not.toHaveBeenCalled();
    expect(q().get('history')).toBe('op-1');
    expect(changes().dataset.entry).toBe('op-1');
    await view.unmount();
  });

  it('leaves what an entry changed for the document as of it when a tab is picked', async () => {
    await mount('/p/p1/d/d1?tab=analyze&history=g1');
    expect(changes()).not.toBeNull();
    const baseline = seen.strip.tabs.find((t) => t.value === 'baseline');
    expect(new URLSearchParams(baseline.to.split('?')[1]).get('historyView')).toBe('document');
    await view.step(() => seen.navigate(baseline.to));
    await settle();
    expect(changes()).toBeNull();
    expect(body().textContent).toBe('baseline');
    expect(body().dataset.name).toBe('Doc then');
    expect(q().get('history')).toBe('g1');
    // On the document, a tab is a tab again.
    expect(seen.strip.tabs.find((t) => t.value === 'analyze').to).toBe(
      '/p/p1/d/d1?tab=analyze&history=g1&historyView=document',
    );
    await view.unmount();
  });

  it('takes the entry out of the address when the screen leaves it on its own', async () => {
    await mount('/p/p1/d/d1?tab=analyze&history=g1');
    await view.step(() => seen.leave());
    await settle();
    expect(q().get('history')).toBeNull();
    expect(q().get('tab')).toBe('analyze');
    expect(changes()).toBeNull();
    await view.unmount();
  });

  it('says so and drops an entry the document does not have', async () => {
    await mount('/p/p1/d/d1?tab=analyze&history=nope');
    expect(notify.notifyError).toHaveBeenCalledWith(
      expect.any(Error),
      'Failed to open that history entry',
    );
    expect(q().get('history')).toBeNull();
    expect(body().textContent).toBe('analyze');
    await view.unmount();
  });

  it('shows the document as of the entry where the app has no view of changes', async () => {
    await mount('/p/p1/d/d1?tab=analyze&history=g1', app({ historyChanges: undefined }));
    expect(changes()).toBeNull();
    expect(switchTo('Changes')).toBeUndefined();
    expect(body().dataset.name).toBe('Doc then');
    expect(view.container.textContent).toContain('This is the document as of');
    await view.unmount();
  });
});
