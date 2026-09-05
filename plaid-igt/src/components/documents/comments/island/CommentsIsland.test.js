import { describe, it, expect, beforeEach } from 'vitest';
import { CommentsIsland } from './CommentsIsland.js';
import { CommentStore } from '@/domain/CommentStore';

const ME = 'me@example.com';

let host;
let seq = 0;

const row = (over = {}) => {
  const n = ++seq;
  const at = `2026-09-05T00:00:${String(n).padStart(2, '0')}.000Z`;
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

// A loaded store with no network: rows are indexed straight in. The live
// stream is stubbed so watchLive() has something harmless to open.
const storeWith = (rows, scope = { projectId: 'p1', documentId: 'd1' }) => {
  const store = new CommentStore({
    client: { messages: { listen: () => ({ close() {} }) } },
    currentUserId: ME,
    ...scope,
  });
  store._index(rows);
  store._loaded = true;
  return store;
};

// The vocabulary page's shape: no document, an index handed in.
const anchors = new Map([
  ['i1', { kind: 'entry', label: 'gam', detail: 'house', jumpId: 'i1' }],
  ['i2', { kind: 'entry', label: 'ar', detail: '', jumpId: 'i2' }],
]);

const threads = () => [...host.querySelectorAll('.igt-cmts__thread')];
const heading = (el) => el.querySelector('.igt-cmts__anchor').textContent.trim();

beforeEach(() => {
  host = document.createElement('div');
  seq = 0;
});

describe('CommentsIsland', () => {
  it('lists live threads, and outdated ones apart under their captions with no composer', () => {
    const store = storeWith(
      [
        row({ entityType: 'vocab-item', entityId: 'i1' }),
        row({ entityType: 'vocab-item', entityId: 'gone', anchorLabel: 'zun, water' }),
        row({ entityType: 'vocab-item', entityId: 'gone' }),
      ],
      { vocabId: 'v1' },
    );
    const jumps = [];
    new CommentsIsland(host, {
      store,
      anchorIndex: () => anchors,
      canWrite: true,
      onJumpTo: (id) => jumps.push(id),
    });

    const [live, stale] = threads();
    expect(threads()).toHaveLength(2);

    expect(heading(live)).toBe('gam');
    expect(live.classList.contains('igt-cmts__thread--outdated')).toBe(false);
    expect(live.querySelector('.igt-cmts__kind').textContent.trim()).toBe('entry');
    expect(live.querySelector('textarea')).not.toBeNull();
    live.querySelector('.igt-cmts__anchor--link').click();
    expect(jumps).toEqual(['i1']);

    expect(stale.classList.contains('igt-cmts__thread--outdated')).toBe(true);
    expect(heading(stale)).toBe('zun, water');
    expect(stale.querySelector('.igt-cmts__kind').textContent.trim()).toBe('outdated');
    expect(stale.querySelector('.igt-cmts__anchor--link')).toBeNull();
    expect(stale.querySelector('textarea')).toBeNull();
    expect(stale.querySelectorAll('.igt-cmt__row')).toHaveLength(2);

    const section = host.querySelector('.igt-cmts__section');
    expect(section.querySelector('.igt-cmts__section-title').textContent.trim()).toBe('Outdated');
    expect(section.contains(stale)).toBe(true);
    expect(section.contains(live)).toBe(false);
  });

  it('falls back to what kind of thing it was when an outdated thread has no caption', () => {
    const store = storeWith([row({ entityId: 'gone', entityType: 'span' })]);
    new CommentsIsland(host, { store, anchorIndex: () => new Map() });
    expect(heading(threads()[0])).toBe('An annotation that was edited away');
    expect(host.querySelector('.igt-cmts__status--quiet')).not.toBeNull();
  });

  it('says the empty text when nothing has comments, in the caller s words', () => {
    const store = storeWith([], { vocabId: 'v1' });
    new CommentsIsland(host, { store, anchorIndex: () => anchors, emptyText: 'Nobody yet.' });
    expect(threads()).toHaveLength(0);
    expect(host.textContent).toContain('Nobody yet.');
  });

  it('pins the document s own thread first when it has a document', () => {
    const store = storeWith([
      row({ entityType: 'token', entityId: 't1', anchorLabel: 'the, sentence 1' }),
    ]);
    const doc = {
      id: 'd1',
      name: 'Text 1',
      dataVersion: 1,
      sentences: [],
      subscribe: () => () => {},
    };
    new CommentsIsland(host, { store, doc, canWrite: true });
    const [pinned, orphan] = threads();
    expect(heading(pinned)).toBe('Text 1');
    expect(pinned.querySelector('textarea')).not.toBeNull();
    // The word is not in this (sentence-less) document, so its thread is outdated.
    expect(heading(orphan)).toBe('the, sentence 1');
    expect(orphan.classList.contains('igt-cmts__thread--outdated')).toBe(true);
  });
});
