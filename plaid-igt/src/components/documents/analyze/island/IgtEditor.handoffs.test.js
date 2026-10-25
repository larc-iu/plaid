import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildRawDoc,
  makeFakeClient,
  resetIds,
  makeIgtDoc,
  mountIsland,
} from '@/domain/test-helpers.js';
import { DOCK_MIN_WINDOW } from '@ui/components/assistant/panelWidth.js';
import { analyzeFocus, tokenizeFocus } from '../../hooks/focusHandoff.js';

// What the island asks of the page around it goes to the callbacks its mount
// hands it, never out through the window: another tab, the Auto-analyze
// dialog, the assistant panel. And the page asks it to land on a sentence by
// calling focusSentence.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let mounted;
let heard;
const onWindow = (e) => heard.push(e.type);
const WINDOW_EVENTS = [
  'igt:navigate-tab',
  'igt:auto-analyze-open',
  'igt:ask-assistant',
  'igt:focus-sentence',
];

const mount = ({ words, ...opts } = {}) => {
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = makeIgtDoc({
    raw: buildRawDoc(words ? { words } : {}),
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: ['lead@x.com'], writers: [] },
    client,
    user: null,
  });
  mounted = mountIsland(doc, opts);
  return { doc, host: mounted.host, editor: mounted.editor };
};

beforeEach(() => {
  resetIds();
  sessionStorage.clear();
  window.innerWidth = DOCK_MIN_WINDOW;
  heard = [];
  for (const type of WINDOW_EVENTS) window.addEventListener(type, onWindow);
});
afterEach(() => {
  mounted?.destroy();
  mounted = null;
  for (const type of WINDOW_EVENTS) window.removeEventListener(type, onWindow);
  expect(heard).toEqual([]);
});

const click = (el, init = {}) =>
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));

describe('onNavigateTab', () => {
  it('is asked for Tokenize by the empty state', () => {
    const onNavigateTab = vi.fn();
    const { host } = mount({ words: [], onNavigateTab });
    click(host.querySelector('.igt-empty__cta'));
    expect(onNavigateTab).toHaveBeenCalledWith('tokenize');
  });

  it('is asked for Tokenize by Alt+click on a word, which hands the word over', () => {
    const onNavigateTab = vi.fn();
    const { host, doc } = mount({ onNavigateTab });
    const form = host.querySelector('.igt-token-form');
    form.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, altKey: true }));
    click(form, { altKey: true });
    expect(onNavigateTab).toHaveBeenCalledWith('tokenize');
    expect(tokenizeFocus.read()).toEqual({
      docId: doc.id,
      sentenceId: doc.sentences[0].id,
      begin: doc.sentences[0].tokens[0].begin,
    });
  });

  it('is not needed: a mount without it does nothing on the press', () => {
    const { host } = mount({ words: [] });
    expect(() => click(host.querySelector('.igt-empty__cta'))).not.toThrow();
  });
});

describe('onOpenAutoAnalyze', () => {
  it('is called by the toolbar button', () => {
    const onOpenAutoAnalyze = vi.fn();
    const { host } = mount({ canAutoAnalyze: true, onOpenAutoAnalyze });
    const button = [...host.querySelectorAll('.igt-toolbar__btn')].find((b) =>
      b.textContent.includes('Auto-analyze'),
    );
    click(button);
    expect(onOpenAutoAnalyze).toHaveBeenCalledTimes(1);
  });
});

describe('onAskAssistant', () => {
  it('is handed the sentence Ask was pressed under', () => {
    const onAskAssistant = vi.fn();
    const { host } = mount({ assistantOnline: true, onAskAssistant });
    click(host.querySelector('.igt-ask'));
    expect(onAskAssistant).toHaveBeenCalledWith({ ref: 's1', label: 'Sentence' });
  });
});

describe('focusSentence', () => {
  it('lands on a sentence of this document through the same request a link makes', () => {
    const { doc, editor } = mount();
    const consume = vi.spyOn(editor, '_consumeFocusRequest').mockImplementation(() => {});
    const sentenceId = doc.sentences[0].id;
    editor.focusSentence({ documentId: doc.id, focus: sentenceId, begin: 4 });
    expect(analyzeFocus.read()).toEqual({ docId: doc.id, sentenceId, begin: 4 });
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("ignores another document's sentence, and a request naming none", () => {
    const { doc, editor } = mount();
    const consume = vi.spyOn(editor, '_consumeFocusRequest');
    editor.focusSentence({ documentId: 'other', focus: doc.sentences[0].id });
    editor.focusSentence({ documentId: doc.id, focus: null });
    expect(analyzeFocus.read()).toBe(null);
    expect(consume).not.toHaveBeenCalled();
  });
});
