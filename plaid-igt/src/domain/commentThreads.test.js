import { describe, it, expect } from 'vitest';
import { CommentStore } from './CommentStore.js';
import { threadList, plainText, sortThreads } from './commentThreads.js';

const ME = 'me@example.com';
const THEM = 'ada@example.com';

let seq = 0;
const row = (over = {}) => {
  const n = ++seq;
  const at = over.createdAt ?? `2026-09-05T00:00:${String(n).padStart(2, '0')}.000Z`;
  return {
    id: `c${n}`,
    entityType: 'token',
    entityId: 't1',
    anchorLabel: null,
    authorId: ME,
    body: `comment ${n}`,
    createdAt: at,
    updatedAt: at,
    edited: false,
    ...over,
  };
};

const storeWith = (rows) => {
  const store = new CommentStore({
    client: {},
    projectId: 'p1',
    documentId: 'd1',
    currentUserId: ME,
  });
  store._index(rows);
  store._loaded = true;
  store._authors.set(THEM, 'Ada Lovelace');
  return store;
};

const anchors = new Map([
  ['d1', { kind: 'document', label: 'Text 1', detail: '', sentenceIndex: null, jumpId: null }],
  [
    's1',
    {
      kind: 'sentence',
      label: 'Sentence 1',
      detail: 'the cat',
      sentenceIndex: 0,
      order: [0, -1, -1, 0],
      jumpId: 's1',
    },
  ],
  [
    't1',
    {
      kind: 'word',
      label: 'cat',
      detail: 'sentence 1',
      sentenceIndex: 0,
      order: [0, 0, -1, 0],
      jumpId: 's1',
    },
  ],
  [
    't9',
    {
      kind: 'word',
      label: 'dog',
      detail: 'sentence 3',
      sentenceIndex: 2,
      order: [2, 0, -1, 0],
      jumpId: 's3',
    },
  ],
]);

describe('plainText', () => {
  it('reduces Markdown to its words', () => {
    expect(plainText('**bold** and _em_ with `code`, a [link](http://x) and\n\n> a quote')).toBe(
      'bold and em with code, a link and a quote',
    );
  });
});

describe('threadList', () => {
  it('pins the document thread, splits outdated from current, and counts before searching', () => {
    seq = 0;
    const store = storeWith([
      row({ entityType: 'document', entityId: 'd1', body: 'about the text' }),
      row({ entityId: 't1', body: 'is this a noun?' }),
      row({ entityId: 't9', body: 'typo?', authorId: THEM }),
      row({ entityId: 'gone', anchorLabel: 'zun, sentence 2', body: 'old remark' }),
    ]);
    const list = threadList(store, anchors, { pinnedId: 'd1' });
    expect(list.pinned.entityId).toBe('d1');
    expect(list.current.map((t) => t.entityId)).toEqual(['t9', 't1']); // newest activity first
    expect(list.outdated.map((t) => t.caption)).toEqual(['zun, sentence 2']);
    expect(list.currentTotal).toBe(2);
    expect(list.outdatedTotal).toBe(1);

    const searched = threadList(store, anchors, { pinnedId: 'd1', query: 'ada' });
    expect(searched.current.map((t) => t.entityId)).toEqual(['t9']); // an author's name matches
    expect(searched.currentTotal).toBe(2); // the total is what the search hid
    expect(threadList(store, anchors, { query: 'ZUN' }).outdated).toHaveLength(1); // caption, any case
    expect(threadList(store, anchors, { query: 'noun' }).current.map((t) => t.entityId)).toEqual([
      't1',
    ]);
  });

  it('keeps the pinned thread present with no comments, and out of the lists', () => {
    const store = storeWith([]);
    const list = threadList(store, anchors, { pinnedId: 'd1' });
    expect(list.pinned).toMatchObject({ entityType: 'document', entityId: 'd1', comments: [] });
    expect(list.current).toEqual([]);
    expect(threadList(store, anchors).pinned).toBeNull();
  });

  it('sorts by latest activity, by first comment, or by place in the text', () => {
    seq = 0;
    const store = storeWith([
      row({ entityId: 't9', createdAt: '2026-09-01T00:00:00.000Z' }),
      row({ entityId: 't9', createdAt: '2026-09-04T00:00:00.000Z' }),
      row({ entityId: 't1', createdAt: '2026-09-02T00:00:00.000Z' }),
      row({ entityId: 's1', createdAt: '2026-09-03T00:00:00.000Z' }),
    ]);
    const ids = (sort) => threadList(store, anchors, { sort }).current.map((t) => t.entityId);
    expect(ids('recent')).toEqual(['t9', 's1', 't1']);
    expect(ids('oldest')).toEqual(['t9', 't1', 's1']);
    expect(ids('position')).toEqual(['s1', 't1', 't9']); // the sentence, then its word, then sentence 3
    expect(sortThreads([], 'nope')).toEqual([]);
  });
});
