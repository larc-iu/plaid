import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { AuthContext } from '@ui/contexts/useAuth.js';
import { SubjectContext } from '@ui/components/assistant/subject.js';
import { DOCK_MIN_WINDOW } from '@ui/components/assistant/panelWidth.js';
import { buildRawDoc, makeFakeClient, resetIds, makeIgtDoc } from '@/domain/test-helpers.js';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { askSentenceFocus } from '../hooks/focusHandoff.js';
import { IgtEditor } from './island/IgtEditor.js';
import { AnalyzeIsland } from './AnalyzeIsland.jsx';

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

const page = ({ goToTab, ask = vi.fn() } = {}) => (
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
        <AnalyzeIsland />
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
});
