import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';
import { CommentStore } from '@ui/domain/CommentStore';
import { hasUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';

// Deleting a comment from the grid's popover. A comment is unaudited, so there
// is no history entry and no restore: the delete is asked for first, the same
// way the entry panel asks, and a mount that cannot ask does not delete.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

const ME = 'me@example.com';

let host;
let editor;

const seededStore = () => {
  const store = new CommentStore({ client: {}, documentId: 'doc-1', currentUserId: ME });
  const comment = {
    id: 'c-1',
    entityType: 'token',
    entityId: 'w-1',
    authorId: ME,
    body: 'check this word',
    createdAt: '2026-09-01T00:00:00.000Z',
  };
  store._loaded = true;
  store._byId.set(comment.id, comment);
  store._byEntity.set('w-1', [comment]);
  store._authors.set(ME, 'Me');
  store.remove = vi.fn(async () => {});
  return store;
};

const mount = (opts = {}, rawOpts = {}) => {
  resetIds();
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw: buildRawDoc(rawOpts),
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: [], writers: [] },
    vocabularies: {},
    client,
    projectId: 'proj-1',
    user: null,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, { canComment: true, ...opts });
  return doc;
};

const openThread = () => {
  // The badge on the word that carries the comment, not the first on screen:
  // an empty sentence badge offers a composer and nothing to delete.
  const badge = host.querySelector('[data-pop-opener="comment:w-1"]');
  expect(badge).not.toBeNull();
  badge.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(host.querySelector('.igt-cmt-pop')).not.toBeNull();
  return host.querySelector('[aria-label="Delete this comment"]');
};

beforeEach(() => {
  host = null;
  editor = null;
});
afterEach(() => {
  editor?.destroy();
  host?.remove();
});

describe('deleting a comment from the grid', () => {
  it('asks first, and keeps the comment when the answer is no', async () => {
    const store = seededStore();
    const confirmDeleteComment = vi.fn(async () => false);
    mount({ comments: store, confirmDeleteComment });

    openThread().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(confirmDeleteComment).toHaveBeenCalledWith(expect.objectContaining({ id: 'c-1' }));
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('removes it when the answer is yes', async () => {
    const store = seededStore();
    const confirmDeleteComment = vi.fn(async () => true);
    mount({ comments: store, confirmDeleteComment });

    openThread().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(store.remove).toHaveBeenCalledWith('c-1');
  });

  it('does not delete at all when there is nothing to ask with', async () => {
    const store = seededStore();
    mount({ comments: store });

    openThread().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(store.remove).not.toHaveBeenCalled();
  });
});

describe('a comment the server refuses, from the grid', () => {
  const composer = () => host.querySelector('.igt-cmt-pop textarea[aria-label="Add a comment"]');
  const typeInto = (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('comes back into the composer, and leaving asks until then', async () => {
    const store = seededStore();
    let refuse;
    store._client = {
      comments: {
        create: () => new Promise((_, reject) => (refuse = () => reject(new Error('HTTP 500')))),
      },
    };
    mount({ comments: store });
    openThread();
    typeInto(composer(), 'first thought');
    expect(hasUnsavedDraft()).toBe('The comment you have typed');
    host.querySelector('.igt-cmt__composer .igt-cmt__btn--primary').click();
    await settle();
    expect(composer().value).toBe('');
    expect(hasUnsavedDraft()).toBe('The comment you have typed');
    refuse();
    await settle();
    expect(composer().value).toBe('first thought');
    // Closing the popover keeps it, and so does reopening.
    editor._closePopover();
    openThread();
    expect(composer().value).toBe('first thought');
    // Leaving the tab takes the island, and the question, with it.
    editor.destroy();
    editor = null;
    expect(hasUnsavedDraft()).toBe(null);
  });

  // L2-IGT-MULTI-2: the value was deleted meanwhile, so no cell opens its
  // thread again. The text moves to the morpheme the value was on, and that
  // thread opens with it.
  it('on a value deleted meanwhile, opens on the nearest anchor still there with the text', async () => {
    const store = seededStore();
    let refuse;
    store._client = {
      comments: {
        create: () => new Promise((_, reject) => (refuse = reject)),
      },
    };
    const doc = mount({ comments: store });
    await doc.updateMorphemeSpan('m-2', 'Gloss', 'CAT');
    await settle();
    host.querySelector('[title="Comment on Gloss of morpheme cat"]').click();
    typeInto(composer(), 'is this CAT or FELINE?');
    host.querySelector('.igt-cmt__composer .igt-cmt__btn--primary').click();
    await settle();
    // Someone clears the value, and the post is refused for the gone anchor.
    await doc.updateMorphemeSpan('m-2', 'Gloss', '');
    await settle();
    refuse(
      Object.assign(new Error('HTTP 403 lacks sufficient privileges'), {
        status: 403,
        method: 'POST',
        responseData: { unresolved: true },
      }),
    );
    await settle();
    const pop = host.querySelector('.igt-cmt-pop');
    expect(pop?.getAttribute('aria-label')).toBe('Comments on morpheme cat');
    expect(composer().value).toBe('is this CAT or FELINE?');
    expect(hasUnsavedDraft()).toBe('The comment you have typed');
  });

  it('on a value deleted after the refusal, moves the text once the document is read again', async () => {
    const store = seededStore();
    store._client = {
      comments: {
        create: async () => {
          throw Object.assign(new Error('HTTP 403 lacks sufficient privileges'), {
            status: 403,
            method: 'POST',
            responseData: { unresolved: true },
          });
        },
      },
    };
    const doc = mount({ comments: store });
    await doc.updateMorphemeSpan('m-2', 'Gloss', 'CAT');
    await settle();
    host.querySelector('[title="Comment on Gloss of morpheme cat"]').click();
    typeInto(composer(), 'second thought');
    host.querySelector('.igt-cmt__composer .igt-cmt__btn--primary').click();
    await settle();
    // Refused while the page still shows the value: the text is back in it.
    expect(composer().value).toBe('second thought');
    // The read after the refusal finds it gone.
    await doc.updateMorphemeSpan('m-2', 'Gloss', '');
    await settle();
    expect(host.querySelector('.igt-cmt-pop')?.getAttribute('aria-label')).toBe(
      'Comments on morpheme cat',
    );
    expect(composer().value).toBe('second thought');
  });

  it('reads left to right in a right-to-left document, and the composer takes its own direction', () => {
    const store = seededStore();
    mount({ comments: store });
    openThread();
    expect(host.querySelector('.igt-cmt-pop').getAttribute('dir')).toBe('ltr');
    expect(composer().getAttribute('dir')).toBe('auto');
  });
});

describe('the comment badge on a morpheme', () => {
  it('is not offered on an unanalyzed word, whose morpheme is not stored', () => {
    mount({ comments: seededStore() }, { morphemes: [] });
    // The word's badge is there, the derived morpheme's is not.
    expect(host.querySelector('[data-pop-opener="comment:w-2"]')).not.toBeNull();
    expect(host.querySelector('[data-pop-opener^="comment:virtual:"]')).toBeNull();
  });

  it('names the morpheme, not just its text, on an analyzed word', () => {
    mount({ comments: seededStore() });
    const word = host.querySelector('[data-pop-opener="comment:w-2"]');
    const morph = host.querySelector('[data-pop-opener="comment:m-2"]');
    expect(word.getAttribute('title')).toBe('Comment on cat');
    expect(morph.getAttribute('title')).toBe('Comment on morpheme cat');
  });

  it("names the morpheme on its fields' badges too", async () => {
    const doc = mount({ comments: seededStore() });
    await doc.updateMorphemeSpan('m-2', 'Gloss', 'CAT');
    await new Promise((r) => setTimeout(r, 0));
    const titles = [...host.querySelectorAll('.igt-cmt-badge')].map((b) => b.title);
    expect(titles).toContain('Comment on Gloss of morpheme cat');
  });
});

describe('opening the comment popover', () => {
  it('puts the caret in the box to type in', () => {
    mount({ comments: seededStore() });
    host.querySelector('[data-pop-opener="comment:w-2"]').click();
    expect(document.activeElement).toBe(
      host.querySelector('.igt-cmt-pop textarea[aria-label="Add a comment"]'),
    );
  });

  it('puts it on Close for someone who can only read', () => {
    mount({ comments: seededStore(), canComment: false });
    host.querySelector('[data-pop-opener="comment:w-1"]').click();
    expect(document.activeElement).toBe(host.querySelector('.igt-cmt-pop__close'));
  });
});
