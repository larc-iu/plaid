import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildRawDoc,
  makeFakeClient,
  resetIds,
  makeIgtDoc,
  mountIsland,
} from '@/domain/test-helpers.js';
import { DOCK_MIN_WINDOW } from '@ui/components/assistant/panelWidth.js';
import { analyzeFocus, baselineFocus, tokenizeFocus } from '../../hooks/focusHandoff.js';

// The Analyze and Baseline tabs hand each other the sentence the reader was
// on (R50). The grid opens on the page and sentence holding Baseline's caret,
// and hands Baseline the sentence it is on when it goes.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

// 30 one-word sentences, a line each: two pages of the grid. Sentence i is
// s00..s29 at code points 4i to 4i+3.
const N = 30;
const body = Array.from({ length: N }, (_, i) => `s${String(i).padStart(2, '0')}`).join('\n');
const spans = (prefix) =>
  Array.from({ length: N }, (_, i) => ({ id: `${prefix}-${i}`, begin: 4 * i, end: 4 * i + 3 }));

let mounted;
const mount = (opts = {}) => {
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = makeIgtDoc({
    raw: buildRawDoc({
      body: opts.body ?? body,
      words: opts.words ?? spans('w'),
      sentences: opts.sentences ?? spans('s'),
    }),
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: ['lead@x.com'], writers: [] },
    client,
    user: null,
  });
  mounted = mountIsland(doc, {});
  return { doc, host: mounted.host, editor: mounted.editor };
};

beforeEach(() => {
  resetIds();
  sessionStorage.clear();
  window.innerWidth = DOCK_MIN_WINDOW;
});
afterEach(() => {
  mounted?.destroy();
  mounted = null;
  vi.restoreAllMocks();
});

const rendered = (host) =>
  [...host.querySelectorAll('.igt-sentence[data-sentence-id]')].map((el) => el.dataset.sentenceId);

describe('from the Baseline tab', () => {
  it("opens on the page and sentence holding Baseline's caret", () => {
    analyzeFocus.write({ docId: 'doc-1', sentenceId: null, begin: null, at: 4 * 27 + 1 });
    const { editor, host } = mount();
    expect(editor._page).toBe(1);
    expect(rendered(host)).toContain('s-27');
  });

  it('opens on the sentence nearest the caret when the caret is between sentences', () => {
    // The caret stood where s-27 was, deleted since.
    analyzeFocus.write({ docId: 'doc-1', sentenceId: null, begin: null, at: 4 * 27 + 1 });
    const sentences = spans('s').filter((s) => s.id !== 's-27');
    const { editor, host } = mount({ sentences });
    expect(editor._page).toBe(1);
    expect(rendered(host)).toContain('s-28');
  });

  it('opens on the first page for a caret before every sentence', () => {
    analyzeFocus.write({ docId: 'doc-1', sentenceId: null, begin: null, at: 0 });
    const { editor } = mount();
    expect(editor._page).toBe(0);
  });

  it('opens a document with no sentences without a landing', () => {
    analyzeFocus.write({ docId: 'doc-1', sentenceId: null, begin: null, at: 3 });
    const { editor } = mount({ body: '', words: [], sentences: [] });
    expect(editor._page).toBe(0);
    expect(analyzeFocus.read()).toBe(null);
  });
});

describe('to the Baseline tab', () => {
  const page2 = (editor) => editor._setPage(1);
  // Lays the page out 100px a sentence, `first` at the window's top plus
  // `offset`, under chrome pinned down to `chrome` px (the tab strip).
  const layout = (host, { first, offset = 0, chrome = 0 }) => {
    for (const el of host.querySelectorAll('.igt-sentence[data-sentence-id]')) {
      const top = (Number(el.dataset.sentenceId.slice(2)) - first) * 100 + offset;
      el.getBoundingClientRect = () => ({ top, bottom: top + 100, height: 100 });
    }
    const strip = document.createElement('div');
    strip.dataset.pinned = 'true';
    strip.getBoundingClientRect = () => ({ top: 0, bottom: chrome, height: chrome });
    document.body.appendChild(strip);
    pinned.push(strip);
  };
  const pinned = [];
  afterEach(() => pinned.splice(0).forEach((el) => el.remove()));
  const cell = (host, id) =>
    host.querySelector(`.igt-sentence[data-sentence-id="${id}"] .igt-field`);

  it("hands over the focused cell's sentence while it is in view", () => {
    const { editor, host, doc } = mount();
    page2(editor);
    layout(host, { first: 25 });
    cell(host, 's-27').focus();
    editor.handToBaseline();
    expect(baselineFocus.read()).toEqual({ docId: doc.id, sentenceId: 's-27', at: 108 });
  });

  it("hands over the last focused cell's sentence once focus has left the grid", () => {
    const { editor, host } = mount();
    page2(editor);
    layout(host, { first: 25 });
    cell(host, 's-26').focus();
    cell(host, 's-26').blur();
    editor.handToBaseline();
    expect(baselineFocus.read().sentenceId).toBe('s-26');
  });

  it('hands over the topmost sentence in view when the focused one is scrolled away', () => {
    const { editor, host } = mount();
    page2(editor);
    cell(host, 's-26').focus();
    layout(host, { first: 28, offset: 10 });
    editor.handToBaseline();
    expect(baselineFocus.read().sentenceId).toBe('s-28');
  });

  it('hands over the topmost sentence whose top is below the pinned chrome', () => {
    const { editor, host } = mount();
    page2(editor);
    // s-27 runs from 50 to 150, its top under the 97px chrome. s-28 starts at 150.
    layout(host, { first: 27, offset: 50, chrome: 97 });
    editor.handToBaseline();
    expect(baselineFocus.read().sentenceId).toBe('s-28');
  });

  it("hands over the page's first sentence when nothing is in view", () => {
    const { editor } = mount();
    page2(editor);
    editor.handToBaseline();
    expect(baselineFocus.read().sentenceId).toBe('s-25');
  });

  it('hands over nothing from a document with no sentences', () => {
    const { editor } = mount({ body: '', words: [], sentences: [] });
    editor.handToBaseline();
    expect(baselineFocus.read()).toBe(null);
  });
});

describe('a handoff is for the next tab only', () => {
  it('clears what was left for Tokenize and Baseline when the grid opens, and lands on its own', () => {
    tokenizeFocus.write({ docId: 'doc-1', sentenceId: 's-3', begin: 12 });
    baselineFocus.write({ docId: 'doc-1', sentenceId: 's-4', at: 16 });
    analyzeFocus.write({ docId: 'doc-1', sentenceId: null, begin: null, at: 4 * 27 });
    const { editor } = mount();
    expect(tokenizeFocus.read()).toBe(null);
    expect(baselineFocus.read()).toBe(null);
    expect(editor._page).toBe(1);
  });
});
