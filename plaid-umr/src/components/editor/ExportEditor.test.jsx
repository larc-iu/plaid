import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';

const state = { doc: null };
vi.mock('@ui/hooks/useDocumentEditor.js', () => ({
  useDocumentEditor: () => ({ doc: state.doc, project: { name: 'P' } }),
}));
vi.mock('@ui/hooks/useDocumentTitle.js', () => ({ useDocumentTitle: () => {} }));

const { ExportEditor } = await import('./ExportEditor.jsx');

const buttons = (r) =>
  Object.fromEntries(
    [...r.container.querySelectorAll('button')].map((b) => [b.textContent.trim(), b]),
  );

describe('ExportEditor', () => {
  // A concept the API stored with a space used to export cut at the space,
  // with nothing said.
  it('lists what the file cannot hold, and offers nothing to copy or download', async () => {
    state.doc = {
      name: 'Lunch',
      exportProblems: [
        {
          sentence: 3,
          var: 's3b',
          message: 'A concept cannot hold spaces, brackets, colons, quotes or #: big dog',
        },
      ],
      toUmr: () => {
        throw new Error('toUmr must not be called');
      },
    };
    const r = await renderComponent(<ExportEditor />);
    const alert = r.container.querySelector('[role="alert"]');
    expect(alert.textContent).toContain('Failed to export.');
    expect(alert.textContent).toContain('Sentence 3, s3b: A concept cannot hold');
    expect(buttons(r).Copy.disabled).toBe(true);
    expect(buttons(r).Download.disabled).toBe(true);
    expect(r.container.querySelector('textarea')).toBeNull();
  });

  it('shows the file when there is nothing to list', async () => {
    state.doc = { name: 'Lunch', exportProblems: [], toUmr: () => '(s1d / dog)' };
    const r = await renderComponent(<ExportEditor />);
    expect(r.container.querySelector('[role="alert"]')).toBeNull();
    expect(r.container.querySelector('textarea').value).toBe('(s1d / dog)');
    expect(buttons(r).Copy.disabled).toBe(false);
  });
});
