import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// A comment refused because the annotation it is on was deleted meanwhile
// (H7-5): the shell reads the document again, so the canvas shows the
// deletion. Any other refusal only says so.
//
// The tab bodies and the hooks around the shell are stubs. What is under test
// is the wiring of the comment store's error channel to the document.

const auth = vi.hoisted(() => ({ getClient: vi.fn(), logout: vi.fn(), user: { id: 'u1' } }));
vi.mock('@ui/contexts/useAuth.js', () => ({ useAuth: () => auth }));

const docs = vi.hoisted(() => []);
vi.mock('../../domain/UmrDocument.js', () => ({
  UmrDocument: class {
    static async load({ documentId }) {
      const doc = new this();
      doc.id = documentId;
      doc.isSaving = false;
      doc.reloads = 0;
      docs.push(doc);
      return doc;
    }
    hold() {
      return () => {};
    }
    reload() {
      this.reloads += 1;
      return Promise.resolve();
    }
  },
}));
vi.mock('@ui/domain/useDocumentModel.js', () => ({ useDocumentModel: () => 0 }));
vi.mock('./DocumentTabs.jsx', () => ({ DocumentTabs: () => null }));
const stores = vi.hoisted(() => []);
vi.mock('@ui/domain/CommentStore', () => ({
  CommentStore: class {
    constructor() {
      stores.push(this);
    }
    load() {
      return Promise.resolve();
    }
  },
}));
const feedback = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock('@ui/lib/notify.js', () => feedback);
vi.mock('@ui/domain/useCommentStore', () => ({ useCommentStore: () => 0 }));
vi.mock('@ui/hooks/useWriteLock.js', () => ({
  useWriteLock: () => ({ held: null, acquire: () => null }),
}));
vi.mock('@ui/hooks/useResumedRun.js', () => ({ useResumedRun: () => {} }));
vi.mock('@ui/hooks/useSavingGuard.js', () => ({ useSavingGuard: () => {} }));
vi.mock('@ui/components/assistant/useAssistantAvailable.js', () => ({
  useAssistantAvailable: () => false,
}));
vi.mock('@ui/components/assistant/subject.js', () => ({
  useAskAssistant: () => () => {},
  useAssistantSubject: () => {},
}));
vi.mock('./hooks/useUmrServices.js', () => ({ useUmrServices: () => ({}) }));
vi.mock('@ui/hooks/useHistoryView.js', () => ({
  useHistoryView: () => ({
    drawerOpen: false,
    openHistory: () => {},
    closeHistory: () => {},
    selectedEntry: null,
    selectEntry: () => {},
    snapshot: null,
    asOf: null,
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

let view;

const mountAt = async (path) => {
  view = await renderComponent(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:projectId/documents/:documentId" element={<DocumentEditorShell />}>
          <Route path="annotate" element={<div data-testid="annotate" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  await view.step(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  feedback.notifyError.mockReset();
  docs.length = 0;
  stores.length = 0;
  auth.getClient.mockReturnValue({
    projects: { get: vi.fn(async () => ({ id: 'p1', name: 'Project' })) },
    documents: { get: vi.fn(async (id) => ({ id, name: 'Doc' })) },
  });
});

describe('the umr document editor shell', () => {
  it('reads the document again when a comment is refused because its annotation is gone', async () => {
    await mountAt('/projects/p1/documents/d1/annotate');
    const store = stores[stores.length - 1];
    const doc = docs[docs.length - 1];
    expect(typeof store.onError).toBe('function');
    expect(doc).toBeTruthy();

    store.onError('Post comment: HTTP 423', { status: 423, method: 'POST' }, 'Post comment');
    expect(doc.reloads).toBe(0);
    store.onError('Post comment: HTTP 404', { status: 404, method: 'POST' }, 'Post comment');
    expect(doc.reloads).toBe(1);
    expect(feedback.notifyError).toHaveBeenCalledTimes(2);
    await view.unmount();
  });
});
