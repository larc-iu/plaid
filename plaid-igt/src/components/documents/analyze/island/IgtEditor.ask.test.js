import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';
import { DOCK_MIN_WINDOW } from '@ui/components/assistant/panelWidth.js';

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

// "Ask the assistant about this sentence", which the island draws itself.
//
// It is offered only where an assistant is online AND the window has room for
// the panel it opens: below that width, pressing it would set a focus nothing
// can open. The island is lit and repaints only when the document's data
// changes, so a window that crosses the threshold left the buttons as they
// were until the next edit.

let host;
let editor;

const mount = ({ assistantOnline = true } = {}) => {
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw: buildRawDoc({}),
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: ['lead@x.com'], writers: [] },
    vocabularies: {},
    client,
    projectId: 'proj-1',
    user: null,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, { assistantOnline });
  return doc;
};

const asks = () => host.querySelectorAll('.igt-ask').length;
const widen = (width) => {
  window.innerWidth = width;
  window.dispatchEvent(new Event('resize'));
};

beforeEach(() => {
  resetIds();
  window.innerWidth = DOCK_MIN_WINDOW;
});
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
  window.innerWidth = DOCK_MIN_WINDOW;
});

describe('the island’s Ask', () => {
  it('is drawn where an assistant is online and the window has room', () => {
    mount();
    expect(asks()).toBeGreaterThan(0);
  });

  it('is not drawn with no assistant online', () => {
    mount({ assistantOnline: false });
    expect(asks()).toBe(0);
  });

  it('is not drawn in a window with no room for the panel', () => {
    window.innerWidth = DOCK_MIN_WINDOW - 1;
    mount();
    expect(asks()).toBe(0);
  });

  it('goes when the window narrows past the threshold, and comes back', () => {
    mount();
    expect(asks()).toBeGreaterThan(0);
    widen(DOCK_MIN_WINDOW - 1);
    expect(asks()).toBe(0);
    widen(DOCK_MIN_WINDOW);
    expect(asks()).toBeGreaterThan(0);
  });

  it('repaints on the crossing only, not on every resize event', () => {
    // A drag emits one of these per frame and the whole grid is rebuilt.
    mount();
    const render = vi.spyOn(editor, '_render');
    widen(1400);
    widen(1300);
    widen(DOCK_MIN_WINDOW);
    expect(render).not.toHaveBeenCalled();
    widen(800);
    expect(render).toHaveBeenCalledTimes(1);
    widen(700);
    widen(600);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('stops listening once the island is gone', () => {
    mount();
    const render = vi.spyOn(editor, '_render');
    editor.destroy();
    widen(800);
    expect(render).not.toHaveBeenCalled();
  });
});
