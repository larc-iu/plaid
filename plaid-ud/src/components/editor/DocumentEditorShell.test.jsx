import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// The document integrity notice is sticky and has a Copy details button, and it
// belongs to the DOCUMENT rather than to the tab that raised it. The Annotate
// tab is a child route of this shell, so it unmounts on every tab switch: an
// effect that dismissed the notice from there took it away while the reader was
// still on the same document, on their way to the Text Editor to act on it.
//
// The tab bodies here are stubs. What is under test is the shell's ownership of
// the notice, which is exactly what a stubbed child cannot fake: with the
// dismiss back down in a tab, nothing here would clear it on the way out.

const toast = vi.hoisted(() => ({
  reportIntegrityFindings: vi.fn(),
  dismissIntegrityFindings: vi.fn(),
}));
vi.mock('@ui/lib/integrityToast.js', () => toast);

const auth = vi.hoisted(() => ({ getClient: vi.fn(), logout: vi.fn(), user: { id: 'u1' } }));
vi.mock('../../contexts/AuthContext.jsx', () => ({ useAuth: () => auth }));

vi.mock('../../domain/ConlluDocument.js', () => ({
  ConlluDocument: class {
    constructor({ raw }) {
      this.raw = raw;
      this.isSaving = false;
      this.sentences = [];
    }
  },
}));
vi.mock('../../domain/useConlluDocument.js', () => ({ useConlluDocument: () => 0 }));
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
vi.mock('../../utils/feedback.jsx', () => feedback);
vi.mock('@ui/domain/useCommentStore', () => ({ useCommentStore: () => 0 }));
vi.mock('@ui/hooks/useWriteLock.js', () => ({
  useWriteLock: () => ({ held: null, acquire: () => null }),
}));
vi.mock('@ui/hooks/useResumedRun.js', () => ({ useResumedRun: () => {} }));
vi.mock('@ui/components/assistant/useAssistantAvailable.js', () => ({
  useAssistantAvailable: () => false,
}));
vi.mock('@ui/components/assistant/subject.js', () => ({
  useAskAssistant: () => () => {},
  useAssistantSubject: () => {},
}));
vi.mock('./hooks/useEditorServices.js', () => ({ useEditorServices: () => ({}) }));

const { DocumentEditorShell } = await import('./DocumentEditorShell.jsx');
const { useDocumentEditor } = await import('./useDocumentEditor.js');

let view;
let go;

const Nav = () => {
  go = useNavigate();
  return null;
};

const Tab = ({ name }) => <div data-testid={name} />;

// A tab that says which document the shell handed it.
const DocTab = () => {
  const { doc } = useDocumentEditor();
  return <div data-testid="show">{doc?.raw?.id}</div>;
};

const mountAt = async (path) => {
  view = await renderComponent(
    <MemoryRouter initialEntries={[path]}>
      <Nav />
      <Routes>
        <Route path="/projects/:projectId" element={<Tab name="project" />} />
        <Route path="/projects/:projectId/documents/:documentId" element={<DocumentEditorShell />}>
          <Route path="annotate" element={<Tab name="annotate" />} />
          <Route path="edit" element={<Tab name="edit" />} />
          <Route path="show" element={<DocTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  // The shell loads the project and the document before it renders the outlet.
  await view.step(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const at = (name) => !!view.container.querySelector(`[data-testid="${name}"]`);
const textOf = (name) => view.container.querySelector(`[data-testid="${name}"]`)?.textContent;

beforeEach(() => {
  toast.dismissIntegrityFindings.mockReset();
  feedback.notifyError.mockReset();
  stores.length = 0;
  auth.getClient.mockReturnValue({
    projects: { get: vi.fn(async () => ({ id: 'p1', name: 'Project' })) },
    documents: { get: vi.fn(async (id) => ({ id, name: 'Doc' })) },
  });
});

describe('the document editor shell', () => {
  it('keeps the integrity notice across a tab switch', async () => {
    await mountAt('/projects/p1/documents/d1/annotate');
    expect(at('annotate')).toBe(true);
    expect(toast.dismissIntegrityFindings).not.toHaveBeenCalled();

    await view.step(() => go('/projects/p1/documents/d1/edit'));
    expect(at('edit')).toBe(true);
    expect(toast.dismissIntegrityFindings).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('drops the integrity notice on the way out of the document', async () => {
    await mountAt('/projects/p1/documents/d1/annotate');
    await view.step(() => go('/projects/p1/documents/d1/edit'));

    await view.step(() => go('/projects/p1'));
    expect(at('project')).toBe(true);
    expect(toast.dismissIntegrityFindings).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  // Opening a document is a read, and a reader can open a second one before the
  // first has answered. Whichever read lands last, the document on screen is
  // the one whose URL is in the bar. The tests above cannot see this: each of
  // them opens one document at a time, so the shell holds the right one at the
  // end whether or not the load is cancelled on the way out.
  it('a document the reader left does not land on the one they opened', async () => {
    const lands = {};
    auth.getClient.mockReturnValue({
      projects: { get: vi.fn(async () => ({ id: 'p1', name: 'Project' })) },
      documents: { get: vi.fn((id) => new Promise((resolve) => (lands[id] = resolve))) },
    });
    await mountAt('/projects/p1/documents/d1/show');
    expect(at('show')).toBe(false); // d1 is still being read

    await view.step(() => go('/projects/p1/documents/d2/show'));
    await view.step(async () => {
      lands.d2({ id: 'd2', name: 'Doc' });
      await Promise.resolve();
    });
    expect(textOf('show')).toBe('d2');

    // d1 answers now, for a screen nobody is on.
    await view.step(async () => {
      lands.d1({ id: 'd1', name: 'Doc' });
      await Promise.resolve();
    });
    expect(textOf('show')).toBe('d2');
    await view.unmount();
  });

  // Every write in the comment store is optimistic, so a refusal shows up as
  // the comment vanishing again. Nothing here read the store's error channel,
  // which is the only thing that says why. What the store calls the write is
  // the toast's TITLE, since that is the line a person scans, and the error
  // rides along as the object so the description reads as a sentence.
  it('says so when a comment write is refused', async () => {
    await mountAt('/projects/p1/documents/d1/annotate');
    const store = stores[0];
    expect(typeof store.onError).toBe('function');

    const err = { status: 423 };
    store.onError('Post comment: HTTP 423', err, 'Post comment');
    expect(feedback.notifyError).toHaveBeenCalledTimes(1);
    expect(feedback.notifyError.mock.calls[0]).toEqual([err, 'Post comment']);
    await view.unmount();
  });

  it('drops it when another document opens in the same shell', async () => {
    await mountAt('/projects/p1/documents/d1/annotate');

    await view.step(() => go('/projects/p1/documents/d2/annotate'));
    expect(toast.dismissIntegrityFindings).toHaveBeenCalledTimes(1);
    await view.unmount();
  });
});
