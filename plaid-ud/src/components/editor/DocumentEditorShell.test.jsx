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
vi.mock('@ui/domain/CommentStore', () => ({
  CommentStore: class {
    load() {
      return Promise.resolve();
    }
  },
}));
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

let view;
let go;

const Nav = () => {
  go = useNavigate();
  return null;
};

const Tab = ({ name }) => <div data-testid={name} />;

const mountAt = async (path) => {
  view = await renderComponent(
    <MemoryRouter initialEntries={[path]}>
      <Nav />
      <Routes>
        <Route path="/projects/:projectId" element={<Tab name="project" />} />
        <Route path="/projects/:projectId/documents/:documentId" element={<DocumentEditorShell />}>
          <Route path="annotate" element={<Tab name="annotate" />} />
          <Route path="edit" element={<Tab name="edit" />} />
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

beforeEach(() => {
  toast.dismissIntegrityFindings.mockReset();
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

  it('drops it when another document opens in the same shell', async () => {
    await mountAt('/projects/p1/documents/d1/annotate');

    await view.step(() => go('/projects/p1/documents/d2/annotate'));
    expect(toast.dismissIntegrityFindings).toHaveBeenCalledTimes(1);
    await view.unmount();
  });
});
