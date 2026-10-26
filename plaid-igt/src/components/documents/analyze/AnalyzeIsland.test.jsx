import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { AuthContext } from '@ui/contexts/useAuth.js';
import { SubjectContext } from '@ui/components/assistant/subject.js';
import { DOCK_MIN_WINDOW } from '@ui/components/assistant/panelWidth.js';
import { buildRawDoc, makeFakeClient, resetIds, makeIgtDoc } from '@/domain/test-helpers.js';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { askSentenceFocus, baselineFocus } from '../hooks/focusHandoff.js';
import { IgtEditor } from './island/IgtEditor.js';
import { AnalyzeIsland } from './AnalyzeIsland.jsx';
import { DocumentBaseline } from '../baseline/DocumentBaseline.jsx';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider';

// The React side of the island's asks. The island is built once, so what it
// is handed has to reach what the page holds NOW: a goToTab made under an
// older query string would write the tab onto that older URL, and everything
// the address picked up since (a focused sentence, a search) would be lost.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));
vi.mock('./AutoAnalyzeDialog.jsx', () => ({
  AutoAnalyzeDialog: ({ open }) => <div data-auto-analyze={open ? 'open' : 'closed'} />,
}));

let doc;
let view;

const page = ({ goToTab, ask = vi.fn(), tab = 'analyze' } = {}) => (
  <AuthContext.Provider value={{ user: null }}>
    <SubjectContext.Provider value={{ ask }}>
      <DocumentProvider
        value={{
          doc,
          readOnly: false,
          comments: null,
          canWrite: true,
          canManage: false,
          assistantOnline: true,
          goToTab,
        }}
      >
        <ConfirmProvider>
          {tab === 'analyze' ? <AnalyzeIsland /> : <DocumentBaseline />}
        </ConfirmProvider>
      </DocumentProvider>
    </SubjectContext.Provider>
  </AuthContext.Provider>
);

const click = (el, init = {}) =>
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));

const makeDoc = (raw) => {
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  return makeIgtDoc({
    raw,
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: ['lead@x.com'], writers: [] },
    client,
    user: null,
  });
};

beforeEach(() => {
  resetIds();
  sessionStorage.clear();
  window.innerWidth = DOCK_MIN_WINDOW;
  doc = makeDoc(buildRawDoc({}));
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  vi.restoreAllMocks();
});

describe('AnalyzeIsland', () => {
  it("sends the island's tab requests to the goToTab the page holds now", async () => {
    doc = makeDoc(buildRawDoc({ words: [] }));
    const first = vi.fn();
    const second = vi.fn();
    view = await renderComponent(page({ goToTab: first }));
    await view.rerender(page({ goToTab: second }));
    await view.step(() => click(view.container.querySelector('.igt-empty__cta')));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('tokenize');
  });

  it('opens the Auto-analyze dialog from the toolbar button', async () => {
    view = await renderComponent(page({ goToTab: vi.fn() }));
    expect(view.container.querySelector('[data-auto-analyze]').dataset.autoAnalyze).toBe('closed');
    const button = [...view.container.querySelectorAll('.igt-toolbar__btn')].find((b) =>
      b.textContent.includes('Auto-analyze'),
    );
    await view.step(() => click(button));
    expect(view.container.querySelector('[data-auto-analyze]').dataset.autoAnalyze).toBe('open');
  });

  it('asks the assistant panel about the sentence Ask was pressed under', async () => {
    const ask = vi.fn();
    view = await renderComponent(page({ goToTab: vi.fn(), ask }));
    await view.step(() => click(view.container.querySelector('.igt-ask')));
    expect(ask).toHaveBeenCalledWith({ ref: 's1', label: 'Sentence' });
  });

  it('hands a citation into the document to the island while it is up, and not after', async () => {
    const focus = vi.spyOn(IgtEditor.prototype, 'focusSentence');
    view = await renderComponent(page({ goToTab: vi.fn() }));
    const req = { documentId: doc.id, focus: doc.sentences[0].id, begin: null };
    askSentenceFocus(req);
    expect(focus).toHaveBeenCalledWith(req);
    await view.unmount();
    view = null;
    askSentenceFocus(req);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('hands the Baseline tab the sentence it is on when it goes, while the grid is still in the page', async () => {
    const hand = IgtEditor.prototype.handToBaseline;
    const inPage = [];
    vi.spyOn(IgtEditor.prototype, 'handToBaseline').mockImplementation(function () {
      inPage.push(this.container.querySelector('.igt-sentence')?.isConnected);
      return hand.call(this);
    });
    view = await renderComponent(page({ goToTab: vi.fn() }));
    expect(baselineFocus.read()).toBe(null);
    await view.unmount();
    view = null;
    expect(inPage).toEqual([true]);
    expect(baselineFocus.read()).toEqual({
      docId: doc.id,
      sentenceId: doc.sentences[0].id,
      at: doc.sentences[0].begin,
    });
  });

  it('lights on the Baseline tab the sentence it was on, in the commit that switches the tab', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    doc = makeDoc(
      buildRawDoc({
        body: 'the cat\nsat',
        words: [
          { id: 'w-1', begin: 0, end: 3 },
          { id: 'w-2', begin: 4, end: 7 },
          { id: 'w-3', begin: 8, end: 11 },
        ],
        sentences: [
          { id: 's-1', begin: 0, end: 7 },
          { id: 's-2', begin: 8, end: 11 },
        ],
      }),
    );
    // A request left from an earlier visit, which the switch replaces.
    baselineFocus.write({ docId: doc.id, sentenceId: 's-1', at: 0 });
    view = await renderComponent(page({ goToTab: vi.fn() }));
    view.container.querySelectorAll('.igt-sentence[data-sentence-id]').forEach((el, i) => {
      el.getBoundingClientRect = () => ({ top: i * 100, bottom: i * 100 + 100, height: 100 });
    });
    view.container.querySelector('.igt-sentence[data-sentence-id="s-2"] .igt-field').focus();
    await view.rerender(page({ goToTab: vi.fn(), tab: 'baseline' }));
    await view.step(() => {});
    expect(view.container.querySelector('.baseline-flash')?.textContent).toBe('sat');
    delete Element.prototype.scrollIntoView;
  });
});
