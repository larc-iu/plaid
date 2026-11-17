import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// H4-1: a reader of a vocabulary was offered the dialog that reorders the
// entries spelled alike, and the drop failed with a permission error. The
// number after the form is a control only for someone who may write entries.

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
vi.mock('@ui/components/assistant/subject.js', () => ({
  useAskAssistant: () => null,
  useAssistantSubject: () => {},
}));
vi.mock('@ui/components/assistant/useDock.js', () => ({ useWideEnoughToDock: () => false }));

// The entry's links go with it, in every document, so the project precedent
// reads an editor took before (precedentCache.js) are dropped.
const precedent = vi.hoisted(() => ({ dropPrecedent: vi.fn() }));
vi.mock('@/domain/precedentCache', () => precedent);

const auth = vi.hoisted(() => ({ client: null, user: { id: 'u', isAdmin: true } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

const { VocabularyItems } = await import('./VocabularyItems.jsx');
const { WriteQueue } = await import('@ui/domain/WriteQueue.js');

const FIELDS = [{ name: 'gloss', type: 'text' }];
const ITEMS = [
  { id: 'kat1', form: 'kat', metadata: { gloss: 'cat' } },
  { id: 'kat2', form: 'kat', metadata: { gloss: 'cut' } },
];

const client = {
  withOperation: (_label, fn) => fn(),
  query: async () => ({ results: [] }),
  vocabLayers: { get: async () => ({ id: 'v1', name: 'Lexicon', config: {}, items: ITEMS }) },
  projects: { list: async () => [] },
  vocabItems: {},
};

const open = async (rights) => {
  auth.client = client;
  const view = await renderComponent(
    <MemoryRouter initialEntries={['/vocabularies/v1?item=kat1']}>
      <VocabularyItems
        vocabularyId="v1"
        vocabulary={{ id: 'v1' }}
        client={client}
        fields={FIELDS}
        writes={new WriteQueue()}
        {...rights}
      />
    </MemoryRouter>,
  );
  for (let i = 0; i < 4; i++) await view.step(async () => {});
  return view;
};

const reorderButtons = () =>
  all(document.body, 'button').filter((b) =>
    (b.getAttribute('aria-label') || '').endsWith('Reorder the entries spelled this way'),
  );

describe('the number of an entry spelled like another', () => {
  it('opens the reorder dialog for a writer', async () => {
    const view = await open({ canManage: false, canEditEntries: true });
    expect(reorderButtons().length).toBeGreaterThan(0);
    await view.unmount();
  });

  it('is only a number for a reader', async () => {
    const view = await open({ canManage: false, canEditEntries: false });
    expect(document.body.textContent).toContain('kat');
    expect(reorderButtons()).toEqual([]);
    await view.unmount();
  });
});
