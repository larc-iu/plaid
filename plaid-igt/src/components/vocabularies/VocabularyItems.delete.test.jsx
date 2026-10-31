import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// Deleting a headword repoints everything that names it: its senses become
// entries of their own, and every field that points at it is cleared. That is
// one write per referring entry, sent in bulk under the one operation, as the
// same walk on load is.

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
          writes={new WriteQueue()}
        />
      </MemoryRouter>,
    );
    // The load and its usage query.
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
    expect(precedent.dropPrecedent).toHaveBeenCalled();
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

// Deleting an entry deletes its links. The delete names how many it saw, and
// the server refuses it when that is no longer the number (D7): a link made
// while the question was open would otherwise go with the entry unannounced.
describe('deleting an entry whose links change', () => {
  const linked = (counts, { refuse = null } = {}) => {
    const { client, calls } = stub();
    const sent = [];
    client.projects.list = async () => [{ id: 'p1', vocabs: [{ id: 'v1' }] }];
    client.query = async (q) => {
      if (q.where[0][0] !== 'link') return { results: [] };
      return { results: [[counts.length > 1 ? counts.shift() : counts[0]]] };
    };
    client.vocabItems.delete = async (id, message, opts) => {
      sent.push([id, opts?.expectedLinkCount]);
      if (refuse) {
        const err = refuse;
        refuse = null;
        throw err;
      }
      calls.deleted.push(id);
    };
    return { client, calls, sent };
  };
  const open = async (client) => {
    auth.client = client;
    const view = await renderComponent(
      <MemoryRouter initialEntries={['/vocabularies/v1?item=deriv1']}>
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
    for (let i = 0; i < 4; i++)
      await view.step(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
  };
  const askAndConfirm = async (view) => {
    await view.step(() => byText('button', 'Delete').click());
    await settle(view);
    await view.step(() => byText('button', 'Delete entry').click());
    await settle(view);
  };

  it('names the count it showed', async () => {
    const { client, sent } = linked([2]);
    const view = await open(client);
    await askAndConfirm(view);
    expect(sent).toEqual([['deriv1', 2]]);
    await view.unmount();
  });

  it('stays open on the new count when a link was made while it was open', async () => {
    const { client, sent } = linked([2, 3]);
    const view = await open(client);
    await askAndConfirm(view);
    expect(sent).toEqual([]);
    expect(document.body.textContent).toContain('Its links changed while this was open.');
    await view.step(() => byText('button', 'Delete entry').click());
    await settle(view);
    expect(sent).toEqual([['deriv1', 3]]);
    await view.unmount();
  });

  it('after a refusal counting links it cannot see, names the count the server gave', async () => {
    const refusal = Object.assign(new Error('HTTP 409'), {
      status: 409,
      method: 'DELETE',
      responseData: { error: 'This entry has 5 links now, not 2', links: 5 },
    });
    const { client, sent, calls } = linked([2], { refuse: refusal });
    const view = await open(client);
    await askAndConfirm(view);
    expect(sent).toEqual([['deriv1', 2]]);
    expect(calls.deleted).toEqual([]);
    // The refusal reads the entries again, and the entry is back.
    const row = all(document.body, 'a').find((a) =>
      [...a.querySelectorAll('*')].some((n) => n.textContent.trim() === 'kai-1'),
    );
    await view.step(() => row.click());
    await settle(view);
    await askAndConfirm(view);
    expect(sent).toEqual([
      ['deriv1', 2],
      ['deriv1', 5],
    ]);
    expect(calls.deleted).toEqual(['deriv1']);
    await view.unmount();
  });

  it('reads the server count from the refusal body links, not its message', async () => {
    const refusal = Object.assign(new Error('HTTP 409'), {
      status: 409,
      method: 'DELETE',
      responseData: { error: 'This entry has 5 links now, not 2' },
    });
    const { client, sent } = linked([2], { refuse: refusal });
    const view = await open(client);
    await askAndConfirm(view);
    const row = all(document.body, 'a').find((a) =>
      [...a.querySelectorAll('*')].some((n) => n.textContent.trim() === 'kai-1'),
    );
    await view.step(() => row.click());
    await settle(view);
    await askAndConfirm(view);
    // No count in the body: the next Delete names the count read at Delete.
    expect(sent).toEqual([
      ['deriv1', 2],
      ['deriv1', 2],
    ]);
    await view.unmount();
  });

  it('a refused delete leaves the senses and references it would have cleared', async () => {
    const refusal = Object.assign(new Error('HTTP 409'), {
      status: 409,
      method: 'POST',
      responseData: { error: 'This entry has 5 links now, not 2', links: 5 },
    });
    const { client, calls, sent } = linked([2], { refuse: refusal });
    auth.client = client;
    const view = await renderComponent(
      <MemoryRouter initialEntries={['/vocabularies/v1?item=head']}>
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
    calls.bulkUpdate.length = 0;
    await askAndConfirm(view);
    expect(sent).toEqual([['head', 2]]);
    expect(calls.deleted).toEqual([]);
    expect(calls.bulkUpdate).toEqual([]);
    await view.unmount();
  });
});

// Ruling Q1: a linked morpheme goes by its entry's type and stores none (R2).
// Deleting the entry takes its links, so the same batch writes the entry's
// type onto each morpheme it leaves, where this person can write.
describe('deleting a typed entry', () => {
  it('writes its type onto the morphemes its links leave, in the delete batch', async () => {
    const { client, calls } = stub();
    const typed = [
      { id: 'suf', form: 's', metadata: { morphType: 'suffix', gloss: 'PL' } },
      { id: 'suf1', form: 's', metadata: { parent: 'suf', senseOrder: 1 } },
    ];
    client.vocabLayers.get = async () => ({ id: 'v1', name: 'Lexicon', config: {}, items: typed });
    const batches = [];
    const inner = client.batched;
    client.batched = async (fn) => {
      const ops = [];
      await inner(async (b) => {
        await fn({
          ...b,
          tokens: { bulkUpdate: (rows) => ops.push(['tokens.bulkUpdate', rows]) },
          vocabItems: {
            ...b.vocabItems,
            delete: (...a) => {
              ops.push(['vocabItems.delete', a[0]]);
              return b.vocabItems.delete(...a);
            },
          },
        });
      });
      batches.push(ops);
    };
    // Its links: two morphemes in p1 (writable), one in p2 (read only), a word.
    client.query = async (q) => {
      if (!q.where.some((c) => c[0] === 'link-token')) return { results: [[4]] };
      expect(q.where[0]).toEqual(['link', '?l', { item: ['suf'] }]);
      return {
        results: [
          ['suf', 'm-1', 'ml1', 'morpheme', 1],
          ['suf', 'm-2', 'ml1', 'morpheme', 1],
          ['suf', 'm-9', 'ml2', 'morpheme', 1],
          ['suf', 'w-1', 'wl1', 'word', 1],
        ],
      };
    };
    client.tokenLayers = { get: async (id) => ({ id, project: id === 'ml2' ? 'p2' : 'p1' }) };
    client.projects.get = async (id) => ({
      id,
      writers: id === 'p1' ? ['u'] : [],
      readers: id === 'p2' ? ['u'] : [],
    });
    auth.user = { id: 'u', isAdmin: false };
    auth.client = client;
    const view = await renderComponent(
      <MemoryRouter initialEntries={['/vocabularies/v1?item=suf']}>
        <VocabularyItems
          vocabularyId="v1"
          vocabulary={{ id: 'v1', maintainers: ['u'] }}
          client={client}
          fields={FIELDS}
          writes={new WriteQueue()}
        />
      </MemoryRouter>,
    );
    for (let i = 0; i < 4; i++) await view.step(async () => {});
    await view.step(() => byText('button', 'Delete').click());
    for (let i = 0; i < 4; i++) await view.step(() => new Promise((r) => setTimeout(r, 0)));
    await view.step(() => byText('button', 'Delete entry').click());
    for (let i = 0; i < 6; i++) await view.step(() => new Promise((r) => setTimeout(r, 0)));
    expect(calls.deleted).toEqual(['suf']);
    const batch = batches.find((ops) => ops.some(([k]) => k === 'vocabItems.delete'));
    expect(batch.filter(([k]) => k === 'tokens.bulkUpdate')).toEqual([
      [
        'tokens.bulkUpdate',
        [
          { id: 'm-1', metadata: [{ op: 'set', path: ['morphType'], value: 'suffix' }] },
          { id: 'm-2', metadata: [{ op: 'set', path: ['morphType'], value: 'suffix' }] },
        ],
      ],
    ]);
    await view.unmount();
    auth.user = { id: 'u', isAdmin: true };
  });
});

// REV-FX-VOCAB-2: the kept types go in the delete's batch, so a document a
// service run holds refuses the whole delete (423). It is said plainly, once.
describe('deleting a typed entry while a linked document is held', () => {
  it('says a linked document is in use, and deletes nothing', async () => {
    const feedback = await import('@/utils/feedback');
    feedback.notifyError.mockClear();
    const { client, calls } = stub();
    client.vocabLayers.get = async () => ({
      id: 'v1',
      name: 'Lexicon',
      config: {},
      items: [{ id: 'suf', form: 's', metadata: { morphType: 'suffix' } }],
    });
    client.query = async (q) =>
      q.where.some((c) => c[0] === 'link-token')
        ? { results: [['suf', 'm-1', 'ml1', 'morpheme', 1]] }
        : { results: [[1]] };
    client.tokenLayers = { get: async (id) => ({ id, project: 'p1' }) };
    client.projects.get = async (id) => ({ id, writers: ['u'] });
    client.batched = async () => {
      const said = 'Document 01a04095-38c4-74d1-8450-a7d6a0267af7 is locked by svc@x.org';
      throw Object.assign(new Error(`HTTP 423 ${said}`), {
        status: 423,
        responseData: { error: said },
      });
    };
    auth.client = client;
    const view = await renderComponent(
      <MemoryRouter initialEntries={['/vocabularies/v1?item=suf']}>
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
    await view.step(() => byText('button', 'Delete').click());
    for (let i = 0; i < 4; i++) await view.step(() => new Promise((r) => setTimeout(r, 0)));
    await view.step(() => byText('button', 'Delete entry').click());
    for (let i = 0; i < 6; i++) await view.step(() => new Promise((r) => setTimeout(r, 0)));
    expect(calls.deleted).toEqual([]);
    expect(feedback.notifyError.mock.calls).toEqual([
      ['A document linked to it is in use. Try again when it is free.', 'Entry not deleted'],
    ]);
    await view.unmount();
  });
});
