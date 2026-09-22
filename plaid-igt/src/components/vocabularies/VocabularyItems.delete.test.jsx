import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// Deleting a headword repoints everything that names it: its senses become
// entries of their own, and every field that points at it is cleared. That is
// one write per referring entry, and it used to be one whole-map PUT each,
// inside the one operation that holds the vocabulary's write lock. The same
// walk on load has gone out in bulk since the bulk conversion.

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

const auth = vi.hoisted(() => ({ client: null, user: { id: 'u', isAdmin: true } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

const { VocabularyItems } = await import('./VocabularyItems.jsx');

const FIELDS = [
  { name: 'gloss', type: 'text' },
  { name: 'root', type: 'item' },
];

// One headword with three senses under it, plus three entries whose `root`
// field points at it: six entries to repoint when it goes.
const HEAD = { id: 'head', form: 'kai', metadata: { gloss: 'go' } };
const ITEMS = [
  HEAD,
  ...[1, 2, 3].map((n) => ({
    id: `sense${n}`,
    form: 'kai',
    metadata: { parent: 'head', senseOrder: n },
  })),
  ...[1, 2, 3].map((n) => ({
    id: `deriv${n}`,
    form: `kai-${n}`,
    metadata: { root: 'head' },
  })),
];

const stub = () => {
  const calls = { bulkUpdate: [], setMetadata: [], deleteMetadata: [], deleted: [] };
  return {
    calls,
    client: {
      withOperation: (_label, fn) => fn(),
      query: async () => ({ results: [] }),
      vocabLayers: {
        get: async () => ({ id: 'v1', name: 'Lexicon', config: {}, items: ITEMS }),
      },
      projects: { list: async () => [] },
      vocabItems: {
        bulkUpdate: async (updates) => calls.bulkUpdate.push(updates),
        setMetadata: async (id, m) => calls.setMetadata.push([id, m]),
        deleteMetadata: async (id) => calls.deleteMetadata.push(id),
        delete: async (id) => calls.deleted.push(id),
      },
    },
  };
};

// The dialog lands in a Radix portal, so the search is over the document.
const byText = (selector, needle) =>
  all(document.body, selector).find((n) => n.textContent.trim() === needle) ?? null;

describe('deleting an entry other entries point at', () => {
  it('repoints them in one bulk write, not one write each', async () => {
    const { client, calls } = stub();
    auth.client = client;
    const view = await renderComponent(
      <MemoryRouter initialEntries={['/vocabularies/v1?item=head']}>
        <VocabularyItems
          vocabularyId="v1"
          vocabulary={{ id: 'v1' }}
          client={client}
          fields={FIELDS}
        />
      </MemoryRouter>,
    );
    // The load, its usage query and the load-time reference repair.
    await view.step(async () => {});
    await view.step(async () => {});
    calls.bulkUpdate.length = 0;

    const del = byText('button', 'Delete');
    expect(del).not.toBeNull();
    await view.step(() => del.click());
    const confirm = byText('button', 'Delete entry');
    expect(confirm).not.toBeNull();
    await view.step(() => confirm.click());

    expect(calls.deleted).toEqual(['head']);
    // Six entries repointed, one request.
    expect(calls.bulkUpdate).toHaveLength(1);
    expect(calls.bulkUpdate[0].map((u) => u.id).sort()).toEqual([
      'deriv1',
      'deriv2',
      'deriv3',
      'sense1',
      'sense2',
      'sense3',
    ]);
    expect(calls.setMetadata).toEqual([]);
    expect(calls.deleteMetadata).toEqual([]);
    await view.unmount();
  });
});
