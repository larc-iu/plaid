import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// An entry linked in a project this person cannot open: the screen counts
// the links it can see, and the server refuses a delete naming that count
// (D7). The question is asked again on the server's count, saying how many
// of the links are out of sight, with no "changed elsewhere" toast, since
// nothing changed (REV-F-BULK defect 6).

const feedback = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  isPermissionError: () => false,
  humanizeError: (e) => String(e),
}));
vi.mock('@/utils/feedback', () => feedback);
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
  const client = {
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
    // One transaction: the queued writes land together or not at all.
    batched: async (fn) => {
      const queued = [];
      await fn({
        vocabItems: {
          bulkUpdate: async (u) => queued.push(() => client.vocabItems.bulkUpdate(u)),
          delete: async (...args) => queued.push(() => client.vocabItems.delete(...args)),
        },
      });
      const updates = calls.bulkUpdate.length;
      try {
        for (const run of queued) await run();
      } catch (e) {
        calls.bulkUpdate.length = updates;
        throw e;
      }
    },
  };
  return { calls, client };
};

// The dialog lands in a Radix portal, so the search is over the document.
const byText = (selector, needle) =>
  all(document.body, selector).find((n) => n.textContent.trim() === needle) ?? null;

const refusal = () =>
  Object.assign(new Error('HTTP 409'), {
    status: 409,
    method: 'POST',
    responseData: { error: 'This entry has 5 links now, not 2', links: 5 },
  });

const linked = (visible) => {
  const { client, calls } = stub();
  const sent = [];
  let refuse = true;
  client.projects.list = async () => [{ id: 'p1', vocabs: [{ id: 'v1' }] }];
  client.query = async (q) => {
    if (q.where[0][0] !== 'link') return { results: [] };
    return { results: [[visible]] };
  };
  client.vocabItems.delete = async (id, message, opts) => {
    sent.push([id, opts?.expectedLinkCount]);
    if (refuse) {
      refuse = false;
      throw refusal();
    }
    calls.deleted.push(id);
  };
  return { client, calls, sent };
};

const open = async (client, item = 'deriv1') => {
  auth.client = client;
  const view = await renderComponent(
    <MemoryRouter initialEntries={[`/vocabularies/v1?item=${item}`]}>
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
const settle = async (view) => {
  for (let i = 0; i < 6; i++)
    await view.step(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
};

describe('deleting an entry with links in projects this person cannot open', () => {
  it('asks again on the server count, saying how many are out of sight', async () => {
    feedback.notifyError.mockClear();
    const { client, sent, calls } = linked(2);
    const view = await open(client);
    await view.step(() => byText('button', 'Delete').click());
    await settle(view);
    await view.step(() => byText('button', 'Delete entry').click());
    await settle(view);
    expect(sent).toEqual([['deriv1', 2]]);
    // Open again by itself, on the count the server gave.
    expect(byText('button', 'Delete entry')).not.toBeNull();
    expect(document.body.textContent).toContain(
      'It is linked to 5 words/morphemes, 3 of them in projects you cannot open.',
    );
    expect(document.body.textContent).not.toContain('Its links changed while this was open.');
    expect(feedback.notifyError).not.toHaveBeenCalled();
    await view.step(() => byText('button', 'Delete entry').click());
    await settle(view);
    expect(sent).toEqual([
      ['deriv1', 2],
      ['deriv1', 5],
    ]);
    expect(calls.deleted).toEqual(['deriv1']);
    await view.unmount();
  });

  it('says the count in a toast when another entry is open by then', async () => {
    feedback.notifyError.mockClear();
    const { client, sent } = linked(2);
    const view = await open(client);
    // The refusal is held until another entry is opened.
    const deleteNow = client.vocabItems.delete;
    let release;
    client.vocabItems.delete = (...args) =>
      new Promise((resolve, reject) => {
        release = () => deleteNow(...args).then(resolve, reject);
      });
    await view.step(() => byText('button', 'Delete').click());
    await settle(view);
    await view.step(() => byText('button', 'Delete entry').click());
    await settle(view);
    const row = all(document.body, 'a').find((a) =>
      [...a.querySelectorAll('*')].some((n) => n.textContent.trim() === 'kai-2'),
    );
    await view.step(() => row.click());
    await settle(view);
    await view.step(async () => release());
    await settle(view);
    expect(sent).toEqual([['deriv1', 2]]);
    expect(byText('button', 'Delete entry')).toBeNull();
    expect(feedback.notifyError).toHaveBeenCalledWith(
      'It is linked to 5 words/morphemes, 3 of them in projects you cannot open.',
      'Entry not deleted',
    );
    await view.unmount();
  });
});
