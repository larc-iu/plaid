import { describe, it, expect, beforeEach } from 'vitest';
import { CommentsIsland } from './CommentsIsland.js';
import { CommentStore } from '@/domain/CommentStore';
import { threadList } from '@/domain/commentThreads';

const ME = 'me@example.com';

let host;
let seq = 0;

const row = (over = {}) => {
  const n = ++seq;
  const at = `2026-09-05T00:00:${String(n).padStart(2, '0')}.000Z`;
  return {
    id: `c${n}`,
    entityType: 'vocab-item',
    entityId: 'i1',
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
const storeWith = (rows, scope = { vocabId: 'v1' }) => {
  const store = new CommentStore({
    client: { messages: { listen: () => ({ close() {} }) } },
    currentUserId: ME,
    ...scope,
  });
  store._index(rows);
  store._loaded = true;
  return store;
};

const anchors = new Map([
  ['d1', { kind: 'document', label: 'Text 1', detail: '', sentenceIndex: null, jumpId: null }],
  ['i1', { kind: 'entry', label: 'gam', detail: 'house', sentenceIndex: null, jumpId: 'i1' }],
  ['i2', { kind: 'entry', label: 'ar', detail: '', sentenceIndex: null, jumpId: 'i2' }],
]);

// Mount with the whole list handed in, the way the shell does after paging.
const mount = (store, opts = {}, listOpts = {}) => {
  const island = new CommentsIsland(host, { store, canWrite: true, ...opts });
  const list = threadList(store, anchors, listOpts);
  island.setThreads({
    pinned: list.pinned,
    threads: [...list.current, ...list.outdated],
    emptyText: 'Nobody yet.',
  });
  return island;
};

const threads = () => [...host.querySelectorAll('.igt-cmts__thread')];
const heading = (el) => el.querySelector('.igt-cmts__anchor').textContent.trim();

beforeEach(() => {
  host = document.createElement('div');
  seq = 0;
});

describe('CommentsIsland', () => {
  it('starts each thread collapsed to its latest comment, and opens it on a click', () => {
    const store = storeWith([row({ body: 'first one' }), row({ body: 'the **latest** one' })]);
    mount(store);
    const [t] = threads();
    expect(t.classList.contains('is-collapsed')).toBe(true);
    expect(t.querySelector('textarea')).toBeNull();
    expect(t.querySelector('.igt-cmts__count').textContent.trim()).toBe('2 comments');
    const summary = t.querySelector('.igt-cmts__summary');
    expect(summary.textContent).toContain('the latest one');
    expect(summary.textContent).not.toContain('first one');

    summary.click();
    const open = threads()[0];
    expect(open.classList.contains('is-open')).toBe(true);
    expect(open.querySelector('textarea')).not.toBeNull();
    expect(open.querySelectorAll('.igt-cmt__row')).toHaveLength(2);
    expect(open.querySelector('.igt-cmts__toggle').getAttribute('aria-expanded')).toBe('true');

    open.querySelector('.igt-cmts__toggle').click();
    expect(threads()[0].classList.contains('is-collapsed')).toBe(true);
  });

  it('opens an outdated thread without a composer, headed by its caption', () => {
    const store = storeWith([row({ entityId: 'gone', anchorLabel: 'zun, water' })]);
    const jumps = [];
    mount(store, { onJumpTo: (id) => jumps.push(id) });
    const [t] = threads();
    expect(t.classList.contains('igt-cmts__thread--outdated')).toBe(true);
    expect(heading(t)).toBe('zun, water');
    expect(t.querySelector('.igt-cmts__kind').textContent.trim()).toBe('outdated');
    expect(t.querySelector('.igt-cmts__anchor--link')).toBeNull();
    t.querySelector('.igt-cmts__summary').click();
    expect(threads()[0].querySelector('textarea')).toBeNull();
    expect(threads()[0].querySelectorAll('.igt-cmt__row')).toHaveLength(1);
    expect(jumps).toEqual([]);
  });

  it('jumps from a current thread s heading, with the given tooltip', () => {
    const store = storeWith([row()]);
    const jumps = [];
    mount(store, { onJumpTo: (id) => jumps.push(id), jumpTitle: 'Open the entry' });
    const link = threads()[0].querySelector('.igt-cmts__anchor--link');
    expect(link.title).toBe('Open the entry');
    link.click();
    expect(jumps).toEqual(['i1']);
    expect(threads()[0].querySelector('.igt-cmts__kind').textContent.trim()).toBe('entry');
  });

  it('keeps the pinned thread open with no toggle, even when empty', () => {
    const store = storeWith([row({ entityId: 'i2' })], { projectId: 'p1', documentId: 'd1' });
    mount(store, {}, { pinnedId: 'd1' });
    const [pinned, other] = threads();
    expect(heading(pinned)).toBe('Text 1');
    expect(pinned.classList.contains('is-open')).toBe(true);
    expect(pinned.querySelector('.igt-cmts__toggle')).toBeNull();
    expect(pinned.querySelector('textarea')).not.toBeNull();
    expect(other.classList.contains('is-collapsed')).toBe(true);
  });

  it('says the empty text it is handed when there are no threads', () => {
    const store = storeWith([]);
    mount(store);
    expect(threads()).toHaveLength(0);
    expect(host.textContent).toContain('Nobody yet.');
  });
});
