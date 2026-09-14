import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';

// The save-status pill. It is painted between grid renders, so it is a lit
// root of its own: an attribute written by hand onto an element lit also binds
// leaves lit's dirty check holding a value the DOM no longer has, and the pill
// stops repainting for the rest of the session.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;

const mount = () => {
  resetIds();
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw: buildRawDoc({}),
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: [], writers: [] },
    vocabularies: {},
    client,
    projectId: 'proj-1',
    user: null,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, {});
  return doc;
};

beforeEach(() => {
  host = null;
  editor = null;
});
afterEach(() => {
  editor?.destroy();
  host?.remove();
});

describe('the save-status pill', () => {
  const pill = () => host.querySelector('.igt-status');

  it('follows the document through a save, and survives a re-render', () => {
    const doc = mount();
    expect(pill().dataset.state).toBe('idle');

    doc._isSaving = true;
    editor._syncStatus();
    expect(pill().dataset.state).toBe('saving');
    expect(pill().textContent).toBe('Saving…');

    // A grid render in the middle of the save: the pill has to come back
    // saying the same thing.
    editor._render(true);
    expect(pill().dataset.state).toBe('saving');
    expect(pill().textContent).toBe('Saving…');

    doc._isSaving = false;
    editor._syncStatus();
    expect(pill().dataset.state).toBe('saved');
    expect(pill().textContent).toBe('Saved ✓');
  });

  it('goes quiet again when the flash is over', () => {
    vi.useFakeTimers();
    const doc = mount();
    doc._isSaving = true;
    editor._syncStatus();
    doc._isSaving = false;
    editor._syncStatus();
    vi.advanceTimersByTime(2000);
    expect(pill().dataset.state).toBe('idle');
    expect(pill().textContent).toBe('');
    vi.useRealTimers();
  });
});
