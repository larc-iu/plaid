import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// An entry's values judged by its tagsets as its morph type gives: a suffix's
// gloss with no fall-back, a sense's by its headword's type, an untyped
// entry's as a stem's. The list's count and the form's Save agree.

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  isPermissionError: () => false,
  humanizeError: (e) => String(e),
}));
vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => async () => true }));
vi.mock('@ui/domain/useCommentStore', () => ({ useCommentStore: () => 0 }));
vi.mock('@ui/components/assistant/useAssistantAvailable.js', () => ({
  useAssistantAvailable: () => false,
}));
// The assistant's "applied" callback is the screen's refetch after an import.
const subject = vi.hoisted(() => ({ current: null }));
vi.mock('@ui/components/assistant/subject.js', () => ({
  useAskAssistant: () => null,
  useAssistantSubject: (s) => {
    subject.current = s;
  },
}));
vi.mock('@ui/components/assistant/useDock.js', () => ({ useWideEnoughToDock: () => false }));

const auth = vi.hoisted(() => ({ client: null, user: { id: 'u', isAdmin: true } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

const { VocabularyItems } = await import('./VocabularyItems.jsx');
const { WriteQueue } = await import('@ui/domain/WriteQueue.js');

const MIXED = { delimiters: '.:', mode: 'mixed', values: [{ value: '3' }] };
const FIELDS = [{ name: 'gloss', type: 'text', tagset: 'Gloss' }];

const stub = (items) => ({
  withOperation: (_label, fn) => fn(() => {}),
  query: async () => ({ results: [] }),
  vocabLayers: {
    get: async () => ({ id: 'v1', name: 'Lexicon', config: {}, items: structuredClone(items) }),
  },
  projects: { list: async () => [] },
  vocabItems: { bulkUpdate: async () => ({}), create: async () => ({ id: 'server-1' }) },
});

const mount = async (client, at) => {
  auth.client = client;
  const view = await renderComponent(
    <MemoryRouter initialEntries={[at]}>
      <VocabularyItems
        vocabularyId="v1"
        vocabulary={{ id: 'v1', config: { igt: { tagsets: { Gloss: MIXED } } } }}
        client={client}
        fields={FIELDS}
        writes={new WriteQueue()}
      />
    </MemoryRouter>,
  );
  await view.step(async () => {});
  await view.step(async () => {});
  return view;
};

const setValue = (el, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const glossInput = () => document.querySelector('input[id$="-field-0"]');
const button = (name) => all(document.body, 'button').find((b) => b.textContent.trim() === name);

const LEXICON = [
  { id: 'ti', form: 'ti', metadata: { morphType: 'suffix', gloss: 'sbj:3.pfv' } },
  { id: 'te', form: 'te', metadata: { parent: 'ti', gloss: 'sbj:3.pfv' } },
  { id: 'sa', form: 'sa', metadata: { morphType: 'stem', gloss: 'sbj:3.pfv' } },
  { id: 'ka', form: 'ka', metadata: { gloss: 'sbj:3.pfv' } },
];

describe("an entry's values under a tagset", () => {
  it('counts a suffix and its sense outside the tagset, and not a stem or an untyped entry', async () => {
    const view = await mount(stub(LEXICON), '/vocabularies/v1');
    expect(document.body.textContent).toContain('2 outside tagset');
    await view.unmount();
  });

  it("refuses a suffix's new lower-case tags on Save, and takes a stem's", async () => {
    const lexicon = LEXICON.map((it) => ({ ...it, metadata: { ...it.metadata, gloss: '3' } }));
    for (const [id, allowed] of [
      ['ti', false],
      ['te', false],
      ['sa', true],
      ['ka', true],
    ]) {
      const view = await mount(stub(lexicon), `/vocabularies/v1?item=${id}`);
      await view.step(() => setValue(glossInput(), 'sbj:3.pfv'));
      expect([id, button('Save').disabled]).toEqual([id, !allowed]);
      await view.unmount();
    }
  });
});
