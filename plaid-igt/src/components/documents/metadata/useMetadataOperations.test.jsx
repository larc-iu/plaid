// The metadata tab's two ways off this screen. Copying a document is the
// shared document model's `copyTo`, not an igt spelling of its own, so what is
// pinned here is the tab's half of that contract: the copy's own name in the
// toast, and the copy's id in the route it pushes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mountDocumentHook, fakeDocument } from '@/test/mountDocumentHook.jsx';
import { useMetadataOperations } from './useMetadataOperations.js';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => navigate,
}));

const { notifySuccess } = vi.hoisted(() => ({ notifySuccess: vi.fn() }));
vi.mock('@/utils/feedback', () => ({
  notifySuccess,
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

// A document that copies the way DocumentModel.copyTo does: the name trimmed,
// a blank one falling back, and `{id, name}` for the copy.
const doc = (over = {}) =>
  fakeDocument({
    projectId: 'proj-1',
    document: { id: 'doc-1', name: 'Test Doc', metadata: {} },
    copyTo: vi.fn(async (name) => {
      const next = (name || '').trim() || 'Test Doc (copy)';
      return { id: 'doc-2', name: next };
    }),
    deleteDocument: vi.fn(async () => true),
    saveNameAndMetadata: vi.fn(async () => true),
    ...over,
  });

const mount = (d) => mountDocumentHook(useMetadataOperations, { doc: d });

beforeEach(() => {
  navigate.mockClear();
  notifySuccess.mockClear();
});

describe('the metadata tab copying its document', () => {
  it('copies under the typed name and opens the copy', async () => {
    const d = doc();
    const h = await mount(d);
    await h.step(() => h.api.handleCopyClick());
    await h.step(() => h.api.updateCopyName('  Second look  '));
    await h.step(() => h.api.handleCopy());

    expect(d.copyTo).toHaveBeenCalledWith('  Second look  ');
    expect(notifySuccess).toHaveBeenCalledWith('"Second look" is ready.', 'Document copied');
    expect(navigate).toHaveBeenCalledWith('/projects/proj-1/documents/doc-2');
    expect(h.api.copyModalOpen).toBe(false);
    expect(h.api.copying).toBe(false);
    await h.unmount();
  });

  it('names the copy the model gave it when the field was emptied', async () => {
    const d = doc();
    const h = await mount(d);
    await h.step(() => h.api.handleCopyClick());
    await h.step(() => h.api.updateCopyName(''));
    await h.step(() => h.api.handleCopy());

    expect(notifySuccess).toHaveBeenCalledWith('"Test Doc (copy)" is ready.', 'Document copied');
    expect(navigate).toHaveBeenCalledWith('/projects/proj-1/documents/doc-2');
    await h.unmount();
  });

  it('stays put when the copy failed', async () => {
    const d = doc({ copyTo: vi.fn(async () => null) });
    const h = await mount(d);
    await h.step(() => h.api.handleCopyClick());
    await h.step(() => h.api.handleCopy());

    expect(navigate).not.toHaveBeenCalled();
    expect(notifySuccess).not.toHaveBeenCalled();
    // The dialog is still standing, so the reader can try again.
    expect(h.api.copyModalOpen).toBe(true);
    expect(h.api.copying).toBe(false);
    await h.unmount();
  });
});
