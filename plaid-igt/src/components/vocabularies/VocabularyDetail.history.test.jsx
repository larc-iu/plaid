import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// A vocabulary's History (audit-vocab-history, ruled b): a rail of every change
// to it, and the vocabulary as it was after any of them, handed to the Entries
// tab read-only and read at that time.

const shown = vi.hoisted(() => ({ props: null }));
vi.mock('./VocabularyItems', () => ({
  VocabularyItems: (props) => {
    shown.props = props;
    return null;
  },
}));
vi.mock('./VocabularyBorrowers', () => ({ VocabularyBorrowers: () => null }));
vi.mock('./VocabularyCommentsTab', () => ({ VocabularyCommentsTab: () => null }));
vi.mock('@/components/projects/settings/TagsetsManager.jsx', () => ({
  TagsetsManager: () => null,
}));
vi.mock('@/utils/feedback', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  humanizeError: (e) => String(e),
}));
vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => async () => false }));
vi.mock('@ui/domain/CommentStore', () => ({
  CommentStore: class {
    load() {
      return Promise.resolve();
    }
  },
}));
vi.mock('@ui/domain/useCommentStore', () => ({ useCommentStore: () => 0 }));
const auth = vi.hoisted(() => ({
  client: null,
  user: { id: 'u', isAdmin: false },
  logout: vi.fn(),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

const { VocabularyDetail } = await import('./VocabularyDetail.jsx');
const { CHANGE_ROWS_CEILING, CHANGE_ROWS_PAGE } = await import(
  '../documents/history/useChangeRows.js'
);

const THEN = '2026-09-20T10:00:00Z';
const reads = [];
const client = {
  projects: { list: async () => [], get: async (id) => ({ id, name: 'Pear', maintainers: ['u'] }) },
  vocabLayers: {
    get: async (id, withItems, asOf) => {
      reads.push([id, !!withItems, asOf ?? null]);
      return {
        id,
        name: 'Lexicon',
        project: 'P',
        config: { igt: { fields: { gloss: { inline: true } } } },
        ...(asOf ? { items: [{ id: 'a', form: 'kai' }] } : {}),
      };
    },
    audit: async (...args) => {
      audits.push(args);
      return log;
    },
    auditPage: async (id, { entryId }) => ({
      entries: log.filter((e) => e.id === entryId),
      nextCursor: null,
    }),
  },
  // What the entry changed: one entry's gloss, and kay merged into kai, its
  // links moved in two documents.
  audit: {
    changesPage: async () => ({ entries: changes, nextCursor: null }),
  },
  documents: {
    get: async (id) => ({ id, name: id === 'd1' ? 'Story one' : 'Story two', project: 'P' }),
  },
};
const linkRow = (id, document) => ({
  kind: 'vocab-link',
  id,
  document,
  before: { id, vocabItem: { id: 'b', layer: 'A', form: 'kay' }, tokens: ['t'] },
  after: { id, vocabItem: { id: 'a', layer: 'A', form: 'kai' }, tokens: ['t'] },
});
const changes = [
  {
    kind: 'vocab-item',
    id: 'a',
    vocabLayer: 'A',
    before: { id: 'a', form: 'kai', metadata: { gloss: 'walk' } },
    after: { id: 'a', form: 'kai', metadata: { gloss: 'go' } },
  },
  { kind: 'vocab-item', id: 'b', vocabLayer: 'A', before: { id: 'b', form: 'kay', metadata: {} } },
  linkRow('l1', 'd1'),
  linkRow('l2', 'd1'),
  linkRow('l3', 'd2'),
];
const audits = [];
const log = [
  {
    id: 'op1',
    time: THEN,
    endTime: THEN,
    message: 'Edit entry "kai"',
    ops: [{ id: 'op1', time: THEN, description: 'Update vocab item x' }],
  },
];

const settle = async (view) => {
  for (let i = 0; i < 4; i++) await view.step(async () => {});
};
const button = (name) => all(document.body, 'button').find((b) => b.textContent.trim() === name);

describe('the vocabulary History', () => {
  it('lists the changes, and hands the Entries tab the vocabulary as it was, read-only', async () => {
    auth.client = client;
    const view = await renderComponent(
      <MemoryRouter initialEntries={['/vocabularies/A']}>
        <Routes>
          <Route path="/vocabularies/:vocabularyId" element={<VocabularyDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await settle(view);
    expect(shown.props.past).toBeNull();

    await view.step(() => button('History').click());
    await settle(view);
    const row = all(document.body, 'span').find((s) => s.textContent === 'Edit entry "kai"');
    expect(row).toBeTruthy();

    await view.step(() => row.click());
    // Read-only from the click, before the read lands.
    await settle(view);
    // A whole entry opens on what it changed, the vocabulary as of it beside.
    expect(document.body.querySelector('[data-testid="history-changes"]')).not.toBeNull();
    await view.step(() => button('Vocabulary').click());
    await settle(view);
    expect(reads).toContainEqual(['A', true, THEN]);
    expect(shown.props.past.time).toBe(THEN);
    expect(shown.props.past.vocabulary.items).toEqual([{ id: 'a', form: 'kai' }]);
    expect(shown.props.canRestore).toBe(true);
    expect(document.body.textContent).toContain('Read-only. This is the vocabulary as of');
    const settings = all(document.body, '[role="tab"]').find((t) =>
      t.textContent.includes('Settings'),
    );
    expect(settings.hasAttribute('data-disabled')).toBe(true);

    await view.step(() => button('Return to current').click());
    await settle(view);
    expect(shown.props.past).toBeNull();
    await view.unmount();
  });

  it('leaves the past state behind when the reader walks to another vocabulary', async () => {
    auth.client = client;
    let go;
    const Nav = () => {
      go = useNavigate();
      return null;
    };
    const view = await renderComponent(
      <MemoryRouter initialEntries={['/vocabularies/A']}>
        <Nav />
        <Routes>
          <Route path="/vocabularies/:vocabularyId" element={<VocabularyDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await settle(view);
    await view.step(() => button('History').click());
    await settle(view);
    const row = all(document.body, 'span').find((s) => s.textContent === 'Edit entry "kai"');
    await view.step(() => row.click());
    await settle(view);
    await view.step(() => button('Vocabulary').click());
    await settle(view);
    expect(shown.props.past).not.toBeNull();

    await view.step(() => go('/vocabularies/B'));
    await settle(view);
    expect(shown.props.vocabularyId).toBe('B');
    expect(shown.props.past).toBeNull();
    expect(document.body.textContent).not.toContain('Read-only. This is the vocabulary as of');
    await view.unmount();
  });

  // A state from before the vocabulary had a project reads `project: null`.
  // The rights are the person's now, in its project now: a maintainer still
  // restores from it, and the page still names its project.
  it('keeps the rights of now at a past state read with no project', async () => {
    const before = {
      ...client,
      vocabLayers: {
        ...client.vocabLayers,
        get: async (id, withItems, asOf) =>
          asOf
            ? { id, name: 'Lexicon', project: null, config: {}, items: [{ id: 'a', form: 'kai' }] }
            : client.vocabLayers.get(id, withItems, asOf),
      },
    };
    auth.client = before;
    const view = await renderComponent(
      <MemoryRouter initialEntries={['/vocabularies/A']}>
        <Routes>
          <Route path="/vocabularies/:vocabularyId" element={<VocabularyDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await settle(view);
    await view.step(() => button('History').click());
    await settle(view);
    const row = all(document.body, 'span').find((s) => s.textContent === 'Edit entry "kai"');
    await view.step(() => row.click());
    await settle(view);
    await view.step(() => button('Vocabulary').click());
    await settle(view);
    expect(shown.props.past.vocabulary.project).toBeNull();
    expect(shown.props.canRestore).toBe(true);
    expect(shown.props.canManage).toBe(true);
    expect(shown.props.canEditEntries).toBe(true);
    expect(document.body.textContent).toContain('Project: Pear');
    await view.unmount();
  });

  it("lists one entry's changes from the entry's History, and every change from the vocabulary's", async () => {
    auth.client = client;
    audits.length = 0;
    const view = await renderComponent(
      <MemoryRouter initialEntries={['/vocabularies/A']}>
        <Routes>
          <Route path="/vocabularies/:vocabularyId" element={<VocabularyDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await settle(view);
    await view.step(() => shown.props.onOpenHistory('a'));
    await settle(view);
    expect(audits.at(-1)).toEqual(['A', undefined, undefined, undefined, 'a']);
    expect(shown.props.historyItemId).toBe('a');
    // The vocabulary's own button widens the rail to every change.
    await view.step(() => button('History').click());
    await settle(view);
    expect(audits.at(-1)).toEqual(['A', undefined, undefined, undefined, undefined]);
    expect(shown.props.historyItemId).toBeNull();
    await view.unmount();
  });

  it('opens an entry a link names on what it changed: entries, a merge, and its links per document', async () => {
    auth.client = client;
    const view = await renderComponent(
      <MemoryRouter initialEntries={['/vocabularies/A?history=op1']}>
        <Routes>
          <Route path="/vocabularies/:vocabularyId" element={<VocabularyDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await settle(view);
    await settle(view);
    const body = document.body;
    expect(body.textContent).toContain('Changes made in this entry');
    expect(body.querySelector('[data-testid="change-count"]').textContent).toBe(
      '2 entries, 3 links in 2 documents',
    );
    const entries = all(body, '[data-entry]');
    expect(entries.map((e) => e.dataset.entry)).toEqual(['a', 'b']);
    expect(entries[0].querySelector('dd del').textContent).toBe('walk');
    expect(entries[1].textContent).toContain('Merged into kai');
    // A gone entry links to this History entry, a living one to itself.
    expect(entries[1].querySelector('a').getAttribute('href')).toBe('/vocabularies/A?history=op1');
    expect(entries[1].querySelectorAll('a')[1].getAttribute('href')).toBe('/vocabularies/A?item=a');
    const docs = all(body, '[data-testid="link-counts"] tbody tr').map((tr) =>
      [...tr.children].map((td) => td.textContent),
    );
    expect(docs).toEqual([
      ['Story one', '2', '', ''],
      ['Story two', '1', '', ''],
    ]);
    // Each document is a link to its own History at this entry.
    expect(body.querySelector('[data-testid="link-counts"] tbody a').getAttribute('href')).toBe(
      '/projects/P/documents/d1?history=op1',
    );
    // The Entries tab is not drawn under the changes.
    expect(all(body, '[role="tab"]')).toHaveLength(0);
    await view.unmount();
  });

  it('opens an action picked inside an entry on what it changed', async () => {
    auth.client = client;
    const asked = [];
    const twoActions = {
      id: 'g1',
      time: THEN,
      endTime: THEN,
      message: 'Edit two entries',
      ops: [
        { id: 'a1', time: THEN, endTime: THEN, description: 'Update vocab item kai' },
        { id: 'a2', time: THEN, endTime: THEN, description: 'Update vocab item kay' },
      ],
    };
    log.push(twoActions);
    const changesPage = client.audit.changesPage;
    client.audit.changesPage = async (entryId) => {
      asked.push(entryId);
      return { entries: changes, nextCursor: null };
    };
    try {
      const view = await renderComponent(
        <MemoryRouter initialEntries={['/vocabularies/A']}>
          <Routes>
            <Route path="/vocabularies/:vocabularyId" element={<VocabularyDetail />} />
          </Routes>
        </MemoryRouter>,
      );
      await settle(view);
      await view.step(() => button('History').click());
      await settle(view);
      const expand = all(document.body, 'button[aria-label="Expand"]').at(-1);
      await view.step(() => expand.click());
      const action = all(document.body, '[data-history-item^="o:"]').find((b) =>
        b.textContent.includes('kay'),
      );
      await view.step(() => action.click());
      await settle(view);
      expect(document.body.querySelector('[data-testid="history-changes"]')).not.toBeNull();
      expect(asked).toContain('a2');
      expect(document.body.textContent).toContain('Changes made in this action');
      await view.unmount();
    } finally {
      log.pop();
      client.audit.changesPage = changesPage;
    }
  });

  // A job's group: a few of the vocabulary's entries, and thousands of rows
  // in documents, the links among them.
  const opened = async (changesPage) => {
    auth.client = { ...client, audit: { changesPage } };
    const view = await renderComponent(
      <MemoryRouter initialEntries={['/vocabularies/A?history=op1']}>
        <Routes>
          <Route path="/vocabularies/:vocabularyId" element={<VocabularyDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    for (let i = 0; i < 4; i++) await settle(view);
    return view;
  };
  const span = (i) => ({
    kind: 'span',
    id: `s${i}`,
    document: 'd1',
    layer: 'L',
    after: { id: `s${i}`, value: 'X', tokens: ['t'] },
  });
  // The entry's whole read in pages of `size`, `n` rows of spans with the
  // three links at the very end.
  const wholeRead =
    (n, size) =>
    (entryId, { vocabLayerId, cursor }) => {
      if (vocabLayerId) return Promise.resolve({ entries: changes.slice(0, 2), nextCursor: null });
      const rows = [...Array.from({ length: n }, (_, i) => span(i)), ...changes.slice(2)];
      const at = cursor ? Number(cursor) : 0;
      const next = at + size < rows.length ? String(at + size) : null;
      return Promise.resolve({ entries: rows.slice(at, at + size), nextCursor: next });
    };

  it('reads a job’s group whole: its entries narrowed, its links from every page', async () => {
    const changesPage = vi.fn(wholeRead(2500, CHANGE_ROWS_PAGE));
    const view = await opened(changesPage);
    expect(changesPage).toHaveBeenCalledWith('op1', {
      vocabLayerId: 'A',
      limit: CHANGE_ROWS_PAGE,
      cursor: undefined,
    });
    // Three pages of the whole read, to its end.
    expect(changesPage.mock.calls.filter(([, o]) => !o.vocabLayerId)).toHaveLength(3);
    expect(document.body.querySelector('[data-testid="change-count"]').textContent).toBe(
      '2 entries, 3 links in 2 documents',
    );
    expect(button('Show more changes')).toBeUndefined();
    await view.unmount();
  });

  it('shows the entries of an entry past the ceiling, its links not counted', async () => {
    const view = await opened(vi.fn(wholeRead(CHANGE_ROWS_CEILING + 10, CHANGE_ROWS_PAGE)));
    expect(document.body.querySelector('[data-testid="change-count"]').textContent).toBe(
      '2 entries',
    );
    expect(all(document.body, '[data-entry]').map((e) => e.dataset.entry)).toEqual(['a', 'b']);
    expect(document.body.querySelector('[data-testid="link-counts"]').textContent).toBe(
      'Too many changes in documents to count.',
    );
    await view.unmount();
  });

  it('draws no entries past the ceiling of the vocabulary’s own rows, and links it as of the entry', async () => {
    const item = (i) => ({
      kind: 'vocab-item',
      id: `i${i}`,
      vocabLayer: 'A',
      after: { id: `i${i}`, form: `w${i}`, metadata: {} },
    });
    const changesPage = vi.fn((entryId, { vocabLayerId, cursor }) => {
      const at = cursor ? Number(cursor) : 0;
      return Promise.resolve({
        entries: vocabLayerId
          ? Array.from({ length: CHANGE_ROWS_PAGE }, (_, i) => item(at + i))
          : [],
        nextCursor: vocabLayerId ? String(at + CHANGE_ROWS_PAGE) : null,
      });
    });
    const view = await opened(changesPage);
    for (let i = 0; i < 10; i++) await settle(view);
    expect(document.body.querySelector('[data-testid="change-count"]').textContent).toBe(
      'Too many changes to show here.',
    );
    expect(all(document.body, '[data-entry]')).toHaveLength(0);
    const link = all(document.body, 'a').find((a) => a.textContent === 'Show vocabulary');
    expect(link.getAttribute('href')).toBe('/vocabularies/A?history=op1&historyView=document');
    await view.unmount();
  });
});
