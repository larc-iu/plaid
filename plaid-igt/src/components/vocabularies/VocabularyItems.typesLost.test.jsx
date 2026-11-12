import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// Deleting an entry with a type whose links lie in projects this person
// cannot write. The delete takes the links, and a morpheme there that took
// its type from the entry is left with none: the type is written onto a
// morpheme only where this person can write the project (planKeptTypes), as
// ending a borrowing does. The question says so, as the Unlink confirm under
// "Used by other projects" does, by the same test (canEditProject on the
// project read), and so does the toast that reports the count instead.

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

const auth = vi.hoisted(() => ({ client: null, user: { id: 'u', isAdmin: false } }));
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
    metadata: { root: 'head', ...(n === 1 ? { morphType: 'suffix' } : {}) },
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

const LINE = 'Morphemes in projects you cannot write that took their type from it will have none.';

// `visible` links this person can count. `refuseWith` the server's count
// when it refuses the first delete (links out of sight), else none.
// `layerProject` is the project of the morpheme layer the visible links are
// in, and `role` this person's role there.
const linked = ({ visible, refuseWith = null, role = 'writers' }) => {
  const { client, calls } = stub();
  const sent = [];
  let refuse = refuseWith != null;
  client.projects.list = async () => [{ id: 'p1', vocabs: [{ id: 'v1' }] }];
  client.query = async (q) => {
    // The usage counts of the list: each entry's links this person can see.
    if (q.where[0][0] === 'vocab')
      return {
        results: [
          ['deriv1', 'morpheme', visible],
          ['deriv2', 'morpheme', visible],
        ],
      };
    if (q.where[0][0] !== 'link') return { results: [] };
    const group = q.return?.group || [];
    // The link count.
    if (!group.length) return { results: [[visible]] };
    // The morpheme layers the links are in, with their role.
    if (group[0] === '?tl') return { results: visible ? [['tl-m', 'morpheme', visible]] : [] };
    return { results: [] };
  };
  client.tokenLayers = { get: async (id) => ({ id, project: 'p2' }) };
  client.projects.get = async (id) => ({
    id,
    readers: [],
    writers: [],
    maintainers: [],
    [role]: ['u'],
  });
  client.vocabItems.delete = async (id, message, opts) => {
    sent.push([id, opts?.expectedLinkCount]);
    if (refuse) {
      refuse = false;
      throw Object.assign(new Error('HTTP 409'), {
        status: 409,
        method: 'POST',
        responseData: { error: `This entry has ${refuseWith} links now`, links: refuseWith },
      });
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

describe('deleting an entry with a type whose links are in projects this person cannot write', () => {
  it('says the morphemes lose the type when the links are in a project they only read', async () => {
    const { client } = linked({ visible: 2, role: 'readers' });
    const view = await open(client);
    await view.step(() => byText('button', 'Delete').click());
    await settle(view);
    expect(document.body.textContent).toContain(
      `It is linked to 2 words/morphemes. Those links will be removed. ${LINE}`,
    );
    await view.unmount();
  });

  it('says nothing of types when every link is in a project they write', async () => {
    const { client } = linked({ visible: 2, role: 'writers' });
    const view = await open(client);
    await view.step(() => byText('button', 'Delete').click());
    await settle(view);
    expect(document.body.textContent).toContain('It is linked to 2 words/morphemes.');
    expect(document.body.textContent).not.toContain('took their type');
    await view.unmount();
  });

  it('says it when the server counts links in projects they cannot open', async () => {
    const { client } = linked({ visible: 2, refuseWith: 5, role: 'writers' });
    const view = await open(client);
    await view.step(() => byText('button', 'Delete').click());
    await settle(view);
    expect(document.body.textContent).not.toContain('took their type');
    await view.step(() => byText('button', 'Delete entry').click());
    await settle(view);
    expect(document.body.textContent).toContain(
      `It is linked to 5 words/morphemes, 3 of them in projects you cannot open. Those links will be removed. ${LINE}`,
    );
    await view.unmount();
  });

  it('says it in the toast that reports the count when another entry is open by then', async () => {
    feedback.notifyError.mockClear();
    const { client } = linked({ visible: 2, refuseWith: 5, role: 'writers' });
    const view = await open(client);
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
    expect(feedback.notifyError).toHaveBeenCalledWith(
      `It is linked to 5 words/morphemes, 3 of them in projects you cannot open. ${LINE}`,
      'Entry not deleted',
    );
    await view.unmount();
  });

  it('says nothing of types for an entry with none', async () => {
    const { client } = linked({ visible: 2, refuseWith: 5, role: 'readers' });
    const view = await open(client, 'deriv2');
    await view.step(() => byText('button', 'Delete').click());
    await settle(view);
    await view.step(() => byText('button', 'Delete entry').click());
    await settle(view);
    expect(document.body.textContent).toContain('3 of them in projects you cannot open');
    expect(document.body.textContent).not.toContain('took their type');
    await view.unmount();
  });
});
