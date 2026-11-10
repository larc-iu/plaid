import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { renderComponent } from '@ui/test/renderComponent.jsx';

const state = { doc: null, project: { name: 'P' } };
vi.mock('@ui/hooks/useDocumentEditor.js', () => ({
  useDocumentEditor: () => ({
    doc: state.doc,
    liveDoc: state.doc,
    documentId: 'd1',
    project: state.project,
    setChromeBusy: () => {},
  }),
}));
vi.mock('@ui/hooks/useDocumentTitle.js', () => ({ useDocumentTitle: () => {} }));
vi.mock('../../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'w@x.org' }, getClient: () => null }),
}));

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

  // IGT moved a sentence: its variables still carry the old number until the
  // repair on open renames them, which ran only from Annotate (PB-10).
  it('repairs the document before it writes the file, for a writer', async () => {
    let done;
    const reconcileOnOpen = vi.fn(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    let repaired = false;
    state.project = { name: 'P', writers: ['w@x.org'] };
    state.doc = {
      id: 'd1',
      name: 'Lunch',
      exportProblems: [],
      reconcileOnOpen,
      describeReconcile: () => null,
      toUmr: () => (repaired ? '(s3t / tree)' : '(s2t / tree)'),
    };
    const r = await renderComponent(<ExportEditor />);
    expect(reconcileOnOpen).toHaveBeenCalledTimes(1);
    expect(r.container.querySelector('textarea')).toBeNull();
    repaired = true;
    await act(async () => done({ findings: [] }));
    expect(r.container.querySelector('textarea').value).toBe('(s3t / tree)');
    state.project = { name: 'P' };
  });

  it('shows the file when there is nothing to list', async () => {
    state.doc = { name: 'Lunch', exportProblems: [], toUmr: () => '(s1d / dog)' };
    const r = await renderComponent(<ExportEditor />);
    expect(r.container.querySelector('[role="alert"]')).toBeNull();
    expect(r.container.querySelector('textarea').value).toBe('(s1d / dog)');
    expect(buttons(r).Copy.disabled).toBe(false);
  });
});
