import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// The file is written from this page's copy of the document, and an edit
// another tab saved (an XPOS, say) reached that copy only on a reload: the
// download left it out with no sign that it had.

const editor = vi.hoisted(() => ({ value: null }));
vi.mock('@ui/hooks/useDocumentEditor.js', () => ({ useDocumentEditor: () => editor.value }));
vi.mock('@ui/components/shared/DocumentFileExport.jsx', () => ({
  DocumentFileExport: ({ content }) => <pre>{content}</pre>,
}));
vi.mock('./ConlluPreview.jsx', () => ({ ConlluPreview: () => null }));

const { ExportEditor } = await import('./ExportEditor.jsx');

describe('the Export tab', () => {
  it('reads the document again when it opens', async () => {
    const reload = vi.fn(async () => {});
    editor.value = {
      doc: { name: 'd', toConllu: () => '# text = a', conlluLosses: () => [] },
      project: { name: 'p' },
      reload,
    };
    const view = await renderComponent(<ExportEditor />);
    expect(reload).toHaveBeenCalledTimes(1);
    await view.rerender(<ExportEditor />);
    expect(reload).toHaveBeenCalledTimes(1);
    await view.unmount();
  });
});
