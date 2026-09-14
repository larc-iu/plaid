import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EntryThreadIsland } from './EntryThreadIsland.js';
import { CommentStore } from '@ui/domain/CommentStore';

// One vocabulary entry's thread. The thread itself is CommentThread's; what
// this owns is the state around it — which entry is shown, whether the store
// has answered yet, and what a failed request says.

let host;
let island;

const ME = 'me@example.com';

const storeWith = () =>
  new CommentStore({ client: {}, projectId: 'p1', vocabId: 'v1', currentUserId: ME });

const mount = (store, opts = {}) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  island = new EntryThreadIsland(host, {
    store,
    entityId: 'i1',
    caption: 'the entry cat',
    canWrite: true,
    confirmDelete: vi.fn(),
    ...opts,
  });
  return island;
};

beforeEach(() => {
  host = null;
  island = null;
});
afterEach(() => {
  island?.destroy();
  host?.remove();
});

describe('the entry thread island', () => {
  it('says it is loading until the store has answered', () => {
    const store = storeWith();
    mount(store);
    expect(host.querySelector('.igt-cmts__status').textContent.trim()).toBe('Loading comments…');

    store._loaded = true;
    store._emit();
    expect(host.querySelector('.igt-cmts__status')).toBeNull();
    expect(host.querySelector('.igt-cmt')).not.toBeNull();
  });

  it('reads a failed request as a sentence, not as the request', () => {
    // The store keeps the raw message so whoever shows it can describe it
    // (the toast path does the same). A status and a URL are not for reading.
    const store = storeWith();
    store._loaded = true;
    store._error =
      'Failed to load comments: HTTP 403 Forbidden at http://localhost:8085/api/v1/comments?vocab-id=v1';
    mount(store);

    const said = host.querySelector('.igt-cmts__error').textContent.trim();
    expect(said).toBe("You don't have permission to do that.");
  });

  it('keeps each entry its own composer draft', () => {
    const store = storeWith();
    store._loaded = true;
    mount(store);

    const type = (v) => {
      const ta = host.querySelector('.igt-cmt__composer textarea');
      ta.value = v;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    };
    type('half a thought');
    island.setEntry({ entityId: 'i2', caption: 'the entry dog' });
    expect(host.querySelector('.igt-cmt__composer textarea').value).toBe('');

    island.setEntry({ entityId: 'i1', caption: 'the entry cat' });
    expect(host.querySelector('.igt-cmt__composer textarea').value).toBe('half a thought');
  });
});
