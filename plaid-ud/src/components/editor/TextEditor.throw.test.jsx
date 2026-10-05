import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// A throw inside a save (a bug, not a refusal the document reports) is shown,
// and the draft stays to be saved again. Save used to do nothing at all.

const auth = vi.hoisted(() => ({ getClient: () => null, user: { id: 'u1' } }));
vi.mock('../../contexts/AuthContext.jsx', () => ({ useAuth: () => auth }));
const editor = vi.hoisted(() => ({ current: null }));
vi.mock('@ui/hooks/useDocumentEditor.js', () => ({ useDocumentEditor: () => editor.current }));
vi.mock('./TokenVisualizer.jsx', () => ({ TokenVisualizer: () => null }));
vi.mock('./services/ParseDialog.jsx', () => ({ ParseDialog: () => null }));
vi.mock('./services/TokenizeDialog.jsx', () => ({ TokenizeDialog: () => null }));
const { notifyError } = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock('../../utils/feedback.jsx', async (importOriginal) => ({
  ...(await importOriginal()),
  notifyError,
}));

const { TextEditor } = await import('./TextEditor.jsx');
const { hasUnsavedDraft } = await import('@ui/hooks/useUnsavedDraft.js');

const typeInto = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const button = (root, text) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

describe('the Text Editor, a save that throws', () => {
  it('shows an error, keeps the draft, and the next Save sends it', async () => {
    const saveText = vi.fn(async () => {
      throw new RangeError('Maximum call stack size exceeded');
    });
    editor.current = {
      projectId: 'p1',
      documentId: 'd1',
      project: { id: 'p1', name: 'P', writers: ['u1'], readers: [], maintainers: [] },
      doc: {
        id: 'd1',
        name: 'D',
        isSaving: false,
        saveText,
        layerInfo: { isConfigured: true, textLayer: { id: 't', text: { id: 'x', body: 'One.' } } },
      },
      services: {},
      writeLockHeld: null,
    };
    const view = await renderComponent(
      <MemoryRouter>
        <TextEditor />
      </MemoryRouter>,
    );
    const box = view.container.querySelector('textarea');
    await view.step(() => typeInto(box, 'One. Two.'));
    await view.step(() => button(view.container, 'Save').click());

    expect(notifyError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'RangeError' }),
      'Failed to save text',
    );
    expect(box.value).toBe('One. Two.');
    expect(hasUnsavedDraft()).toBe('The text you have typed');
    expect(view.container.textContent).toContain('Unsaved changes');
    const save = button(view.container, 'Save');
    expect(save.disabled).toBe(false);

    const sent = [];
    editor.current.doc.saveText = vi.fn(async (log) => {
      sent.push(log);
      return false;
    });
    await view.step(() => save.click());
    expect(sent).toHaveLength(1);
    expect(sent[0].base).toBe('One.');
    expect(sent[0].gaps).toEqual([{ start: 4, end: 4, value: ' Two.' }]);
    await view.unmount();
  });
});
