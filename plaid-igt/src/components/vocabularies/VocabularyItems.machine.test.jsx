import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { settle } from '@/domain/test-helpers.js';

// The entries a job made carry the Status value machine ("Machine draft").
// The Entries screen lists them on their own (`?status=machine`, so a job's
// report can link there), and people mark them reviewed or delete them, all
// the list shows at once, in one operation each (SPEC 7.4).

vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
  isPermissionError: () => false,
  humanizeError: (e) => String(e),
}));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => confirm }));
vi.mock('@ui/domain/useCommentStore', () => ({ useCommentStore: () => 0 }));
vi.mock('@ui/components/assistant/useAssistantAvailable.js', () => ({
  useAssistantAvailable: () => false,
}));
vi.mock('@ui/components/assistant/subject.js', () => ({
  useAskAssistant: () => null,
  useAssistantSubject: () => {},
}));
vi.mock('@ui/components/assistant/useDock.js', () => ({ useWideEnoughToDock: () => false }));
const precedent = vi.hoisted(() => ({ dropPrecedent: vi.fn() }));
vi.mock('@/domain/precedentCache', () => precedent);

const auth = vi.hoisted(() => ({ client: null, user: { id: 'u', isAdmin: false } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

const { VocabularyItems } = await import('./VocabularyItems.jsx');
const { WriteQueue } = await import('@ui/domain/WriteQueue.js');

const FIELDS = [
  { name: 'gloss', type: 'text' },
  { name: 'state', type: 'text', role: 'status', tagset: 'Status' },
  { name: 'seeAlso', type: 'item', many: true },
];

// 120 machine drafts, more than one page of the list holds, beside entries a
// person made: one reviewed, one with no status, a sense a person put under
// the first draft, and an entry whose See also names the second.
const DRAFTS = Array.from({ length: 120 }, (_, i) => ({
  id: `d${i}`,
  form: `ma${i}`,
  metadata: { gloss: `g${i}`, state: 'machine' },
}));
const PEOPLE = [
  { id: 'kept', form: 'kai', metadata: { gloss: 'go', state: 'reviewed' } },
  { id: 'bare', form: 'nu', metadata: { gloss: 'see' } },
  { id: 'sense', form: 'ma0', metadata: { parent: 'd0', senseOrder: 1, state: 'draft' } },
  { id: 'refers', form: 'ta', metadata: { seeAlso: ['d1', 'kept'] } },
];

// The server applies what is written to it, so a read after a write sees the
// write, and a test can change an entry there as another person would.
const stub = ({ links = 40 } = {}) => {
  const items = structuredClone([...DRAFTS, ...PEOPLE]);
  const calls = [];
  const operations = [];
  const apply = (updates) => {
    for (const u of updates) {
      const it = items.find((x) => x.id === u.id);
      for (const op of (it && u.metadata) || []) {
        const { [op.path[0]]: _was, ...rest } = it.metadata || {};
        it.metadata = op.op === 'set' ? { ...rest, [op.path[0]]: op.value } : rest;
      }
    }
  };
  const remove = (ids) => {
    for (const id of ids) {
      const i = items.findIndex((x) => x.id === id);
      if (i >= 0) items.splice(i, 1);
    }
  };
  const client = {
    withOperation: (label, fn, opts) => {
      operations.push([label, opts]);
      return fn(() => {});
    },
    // One transaction: each queued write is recorded, in order, as one batch.
    batched: async (fn) => {
      const ops = [];
      await fn({
        vocabItems: {
          bulkUpdate: (u) => ops.push(['bulkUpdate', u]),
          bulkDelete: (ids) => ops.push(['bulkDelete', ids]),
        },
        tokens: { bulkUpdate: (u) => ops.push(['tokens.bulkUpdate', u]) },
      });
      calls.push(['batch', ops]);
      for (const [k, arg] of ops) {
        if (k === 'bulkUpdate') apply(arg);
        if (k === 'bulkDelete') remove(arg);
      }
      return [];
    },
    query: async () => ({ results: [[links]] }),
    vocabLayers: {
      get: async () => ({ id: 'v1', name: 'Lexicon', config: {}, items: structuredClone(items) }),
    },
    projects: { list: async () => [{ id: 'P', vocabs: [{ id: 'v1' }] }] },
    tokenLayers: { get: async () => ({}) },
    vocabItems: {
      bulkUpdate: async (updates) => {
        calls.push(['bulkUpdate', updates]);
        apply(updates);
        return { count: updates.length };
      },
    },
  };
  return { client, calls, operations, items };
};

// Where the address is, after a click.
const where = { current: null };
const Location = () => {
  const loc = useLocation();
  where.current = `${loc.pathname}${loc.search}`;
  return null;
};

const mount = async (client, at, { canManage = true, canEditEntries = true } = {}) => {
  auth.client = client;
  const view = await renderComponent(
    <MemoryRouter initialEntries={[at]}>
      <Location />
      <VocabularyItems
        vocabularyId="v1"
        vocabulary={{ id: 'v1' }}
        client={client}
        fields={FIELDS}
        writes={new WriteQueue()}
        canManage={canManage}
        canEditEntries={canEditEntries}
      />
    </MemoryRouter>,
  );
  await view.step(async () => {});
  await view.step(async () => {});
  await view.step(async () => {});
  return view;
};

const button = (name) =>
  all(document.body, 'button').find((b) => b.textContent.trim() === name) ?? null;
const anchor = (name) => all(document.body, 'a').find((a) => a.textContent.trim() === name) ?? null;
// The forms of the rows the list draws on this page.
const rowForms = () =>
  all(document.body, 'a[data-selected], a[href*="item="]')
    .map((a) => a.querySelector('span span')?.textContent?.trim())
    .filter(Boolean);
// The count over the list: "120 of 124 entries", or "124 entries" for all.
const shownCount = () =>
  all(document.body, 'span')
    .map((s) => s.textContent.trim())
    .find((t) => /^\d[\d,]*( of \d[\d,]*)? entr/.test(t));

beforeEach(() => {
  confirm.mockReset();
  confirm.mockImplementation(async () => true);
});

describe('the machine drafts on the Entries screen', () => {
  it('counts them on a link to the list of them alone, which the address keeps', async () => {
    const { client } = stub();
    const view = await mount(client, '/vocabularies/v1');
    const toggle = anchor('120 machine drafts');
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute('href')).toBe('/vocabularies/v1?status=machine');
    await view.step(() => toggle.click());
    expect(where.current).toBe('/vocabularies/v1?status=machine');
    expect(shownCount()).toBe('120 of 124 entries');
    expect(rowForms().length).toBeGreaterThan(0);
    expect(rowForms().every((f) => /^ma\d+$/.test(f))).toBe(true);
    // Pressed again, it goes back to every entry.
    const back = anchor('120 machine drafts');
    expect(back.getAttribute('href')).toBe('/vocabularies/v1');
    await view.step(() => back.click());
    expect(shownCount()).toBe('124 entries');
    await view.unmount();
  });

  it('is not offered when there are none, and an address asking for them shows every entry', async () => {
    const { client, items } = stub();
    for (const it of items) if (it.metadata?.state === 'machine') it.metadata.state = 'draft';
    const view = await mount(client, '/vocabularies/v1?status=machine');
    expect(all(document.body, 'a').some((a) => /machine draft/.test(a.textContent))).toBe(false);
    expect(button('Mark reviewed')).toBeNull();
    expect(where.current).toBe('/vocabularies/v1');
    expect(shownCount()).toBe('124 entries');
    await view.unmount();
  });

  it('marks every one the list shows reviewed, on every page, in one request of kind review', async () => {
    const { client, calls, operations } = stub();
    const view = await mount(client, '/vocabularies/v1?status=machine', { canManage: false });
    // A writer marks them reviewed and does not delete them.
    expect(button('Delete')).toBeNull();
    const mark = button('Mark reviewed');
    expect(mark).not.toBeNull();
    await view.step(async () => {
      mark.click();
      await settle(10);
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Mark 120 entries reviewed?',
        confirmLabel: 'Mark reviewed',
      }),
    );
    expect(operations).toEqual([
      ['Mark machine drafts reviewed', expect.objectContaining({ kind: 'review' })],
    ]);
    const sent = calls.filter(([k]) => k === 'bulkUpdate');
    expect(sent).toHaveLength(1);
    expect(sent[0][1].map((u) => u.id).sort()).toEqual(DRAFTS.map((d) => d.id).sort());
    for (const u of sent[0][1]) {
      expect(u.metadata).toEqual([{ op: 'set', path: ['state'], value: 'reviewed' }]);
    }
    // Nothing is left to show on its own, so the list is every entry again.
    expect(anchor('120 machine drafts')).toBeNull();
    expect(where.current).toBe('/vocabularies/v1');
    await view.unmount();
  });

  it('marks only what the search shows on top of the filter', async () => {
    const { client, calls } = stub();
    const view = await mount(client, '/vocabularies/v1?status=machine');
    const search = document.querySelector('input[placeholder="Search entries…"]');
    await view.step(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, 'ma11');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await view.step(async () => settle(5));
    await view.step(async () => {
      button('Mark reviewed').click();
      await settle(10);
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Mark 11 entries reviewed?' }),
    );
    const sent = calls.filter(([k]) => k === 'bulkUpdate');
    expect(sent[0][1].map((u) => u.id).sort()).toEqual(
      ['d11', ...Array.from({ length: 10 }, (_, i) => `d11${i}`)].sort(),
    );
    await view.unmount();
  });

  it('writes nothing when the question is answered no', async () => {
    const { client, calls } = stub();
    confirm.mockImplementation(async () => false);
    const view = await mount(client, '/vocabularies/v1?status=machine');
    await view.step(async () => {
      button('Mark reviewed').click();
      await settle(10);
    });
    await view.step(async () => {
      button('Delete').click();
      await settle(10);
    });
    expect(calls).toEqual([]);
    expect(anchor('120 machine drafts')).not.toBeNull();
    await view.unmount();
  });

  it('deletes every one the list shows for a maintainer, through the delete planner, in one batch of kind bulk-edit', async () => {
    const { client, calls, operations } = stub();
    const view = await mount(client, '/vocabularies/v1?status=machine');
    expect(button('Mark reviewed')).not.toBeNull();
    const del = button('Delete');
    expect(del).not.toBeNull();
    await view.step(async () => {
      del.click();
      await settle(10);
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Delete 120 entries?',
        description: '40 links to them are removed.',
        confirmLabel: 'Delete',
        destructive: true,
      }),
    );
    expect(operations).toEqual([
      ['Delete machine drafts', expect.objectContaining({ kind: 'bulk-edit' })],
    ]);
    const batches = calls.filter(([k]) => k === 'batch');
    expect(batches).toHaveLength(1);
    const ops = batches[0][1];
    // The sense under a draft becomes a headword and the See also that named
    // one drops it, in the same batch as the delete.
    const updates = ops.filter(([k]) => k === 'bulkUpdate').flatMap(([, u]) => u);
    expect(updates.map((u) => u.id).sort()).toEqual(['refers', 'sense']);
    const deleted = ops.filter(([k]) => k === 'bulkDelete').flatMap(([, ids]) => ids);
    expect(deleted.sort()).toEqual(DRAFTS.map((d) => d.id).sort());
    expect(ops.at(-1)[0]).toBe('bulkDelete');
    expect(precedent.dropPrecedent).toHaveBeenCalled();
    expect(anchor('120 machine drafts')).toBeNull();
    await view.unmount();
  });

  // The confirm counts the list as drawn and the write plans from a fresh
  // read, so an entry another person changed in between is left as they made
  // it. Once the write lands the list is read again and shows that (REV-J-C-6).
  it('reads the entries again once the delete lands, so one another person kept shows as kept', async () => {
    const { client, items: server } = stub();
    const view = await mount(client, '/vocabularies/v1?status=machine');
    // Another person reviews d5 after the list was drawn.
    server.find((it) => it.id === 'd5').metadata.state = 'reviewed';
    await view.step(async () => {
      button('Delete').click();
      await settle(10);
    });
    await view.step(async () => settle(10));
    expect(server.map((it) => it.id).sort()).toEqual(['bare', 'd5', 'kept', 'refers', 'sense']);
    expect(shownCount()).toBe('5 entries');
    await view.unmount();
  });

  it('reads the entries again once Mark reviewed lands, so a draft made meanwhile shows', async () => {
    const { client, items: server } = stub();
    const view = await mount(client, '/vocabularies/v1?status=machine');
    // A job makes another draft after the list was drawn.
    server.push({ id: 'late', form: 'mo', metadata: { gloss: 'x', state: 'machine' } });
    await view.step(async () => {
      button('Mark reviewed').click();
      await settle(10);
    });
    await view.step(async () => settle(10));
    expect(server.find((it) => it.id === 'late').metadata.state).toBe('machine');
    expect(anchor('1 machine draft')).not.toBeNull();
    await view.unmount();
  });

  it('asks without a link count when the drafts have no links', async () => {
    const { client } = stub({ links: 0 });
    confirm.mockImplementation(async () => false);
    const view = await mount(client, '/vocabularies/v1?status=machine');
    await view.step(async () => {
      button('Delete').click();
      await settle(10);
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Delete 120 entries?', description: undefined }),
    );
    await view.unmount();
  });

  it('offers neither to a reader', async () => {
    const { client } = stub();
    const view = await mount(client, '/vocabularies/v1?status=machine', {
      canManage: false,
      canEditEntries: false,
    });
    expect(anchor('120 machine drafts')).not.toBeNull();
    expect(button('Mark reviewed')).toBeNull();
    expect(button('Delete')).toBeNull();
    await view.unmount();
  });

  it("leaves a draft's status alone when a person edits it", async () => {
    const { client, calls } = stub();
    const view = await mount(client, '/vocabularies/v1?item=d5');
    const gloss = document.querySelector('input[id$="-field-0"]');
    await view.step(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(gloss, 'eat');
      gloss.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await view.step(async () => {
      button('Save').click();
      await settle(10);
    });
    const sent = calls.filter(([k]) => k === 'bulkUpdate');
    expect(sent).toEqual([
      ['bulkUpdate', [{ id: 'd5', metadata: [{ op: 'set', path: ['gloss'], value: 'eat' }] }]],
    ]);
    await view.unmount();
  });
});
