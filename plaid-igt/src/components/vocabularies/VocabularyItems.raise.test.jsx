import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// Add headword makes a new entry over the open one under an id this page
// minted, and the open one becomes its first sense. The create and the
// repoint are one batch, so a refused repoint leaves no headword without a
// sense.

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
const ITEMS = [{ id: 'kai', form: 'kai', metadata: { gloss: 'go' } }];

const stub = ({ refuseRepoint = false } = {}) => {
  // Every write the server holds, and the batches they went in.
  const stored = [];
  const batches = [];
  const client = {
    withOperation: (_label, fn) => fn(),
    query: async () => ({ results: [] }),
    vocabLayers: {
      get: async () => ({ id: 'v1', name: 'Lexicon', config: {}, items: ITEMS }),
    },
    projects: { list: async () => [] },
    vocabItems: {
      create: async (layer, form, metadata, message, opts) => {
        stored.push(['create', form, opts?.id]);
        return { id: opts?.id };
      },
      bulkUpdate: async (updates) => {
        if (refuseRepoint) throw Object.assign(new Error('refused'), { status: 403 });
        stored.push(['bulkUpdate', updates.map((u) => u.id)]);
      },
    },
    // One transaction: the queued writes land together or not at all.
    batched: async (fn) => {
      const queued = [];
      const ops = [];
      await fn({
        vocabItems: {
          create: async (...args) => {
            ops.push('create');
            queued.push(() => client.vocabItems.create(...args));
            return { batched: true };
          },
          bulkUpdate: async (u) => {
            ops.push('bulkUpdate');
            queued.push(() => client.vocabItems.bulkUpdate(u));
            return { batched: true };
          },
        },
      });
      batches.push(ops);
      const before = stored.length;
      try {
        for (const run of queued) await run();
      } catch (e) {
        stored.length = before;
        throw e;
      }
    },
  };
  return { client, stored, batches };
};

const open = async (client) => {
  auth.client = client;
  const view = await renderComponent(
    <MemoryRouter initialEntries={['/vocabularies/v1?item=kai']}>
      <VocabularyItems
        vocabularyId="v1"
        vocabulary={{ id: 'v1' }}
        client={client}
        fields={FIELDS}
        writes={new WriteQueue()}
      />
    </MemoryRouter>,
  );
  for (let i = 0; i < 4; i++) await view.step(async () => {});
  return view;
};

const raise = async (view) => {
  const button = all(document.body, 'button').find((n) =>
    n.textContent.trim().endsWith('Add headword'),
  );
  expect(button).toBeTruthy();
  await view.step(() => button.click());
  for (let i = 0; i < 6; i++)
    await view.step(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
};

describe('Add headword', () => {
  it('creates the headword and makes the entry its sense in one batch', async () => {
    const { client, stored, batches } = stub();
    const view = await open(client);
    await raise(view);
    expect(batches).toEqual([['create', 'bulkUpdate']]);
    const created = stored.find((w) => w[0] === 'create');
    expect(created[1]).toBe('kai');
    expect(created[2]).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored.find((w) => w[0] === 'bulkUpdate')[1]).toEqual(['kai']);
    await view.unmount();
  });

  it('leaves no headword when the repoint is refused', async () => {
    const { client, stored } = stub({ refuseRepoint: true });
    const view = await open(client);
    await raise(view);
    expect(stored).toEqual([]);
    await view.unmount();
  });
});
