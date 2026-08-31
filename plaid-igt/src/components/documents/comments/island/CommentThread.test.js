import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'lit-html';
import { commentThread, timeAgo } from './CommentThread.js';
import { CommentStore } from '@/domain/CommentStore';

const ME = 'me@example.com';
const THEM = 'them@example.com';

let host;
let seq = 0;

const comment = (over = {}) => {
  const n = ++seq;
  const at = `2026-08-31T00:00:${String(n).padStart(2, '0')}.000Z`;
  return {
    id: `c${n}`,
    entityType: 'token',
    entityId: 't1',
    authorId: ME,
    body: `comment ${n}`,
    createdAt: at,
    updatedAt: at,
    edited: false,
    ...over,
  };
};

// A store with names pre-seeded, so the view can be exercised without any
// network stubbing. The view only reads currentUserId / canEdit / authorName.
const storeWith = (names = {}) => {
  const store = new CommentStore({
    client: {},
    projectId: 'p1',
    documentId: 'd1',
    currentUserId: ME,
  });
  for (const [id, name] of Object.entries(names)) store._authors.set(id, name);
  return store;
};

const noopHandlers = () => ({
  startEdit: vi.fn(),
  cancelEdit: vi.fn(),
  changeEdit: vi.fn(),
  saveEdit: vi.fn(),
  remove: vi.fn(),
  changeComposer: vi.fn(),
  submit: vi.fn(),
});

const draw = (opts) => {
  render(commentThread({ store: storeWith(), on: noopHandlers(), ...opts }), host);
  return host;
};

const text = (sel) => [...host.querySelectorAll(sel)].map((el) => el.textContent.trim());
const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent.trim());

beforeEach(() => {
  seq = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
});

describe('timeAgo', () => {
  const now = Date.parse('2026-08-31T12:00:00.000Z');

  it('reads as prose at each scale', () => {
    expect(timeAgo('2026-08-31T11:59:50.000Z', now)).toBe('just now');
    expect(timeAgo('2026-08-31T11:59:00.000Z', now)).toBe('1 minute ago');
    expect(timeAgo('2026-08-31T11:30:00.000Z', now)).toBe('30 minutes ago');
    expect(timeAgo('2026-08-31T09:00:00.000Z', now)).toBe('3 hours ago');
    expect(timeAgo('2026-08-29T12:00:00.000Z', now)).toBe('2 days ago');
  });

  it('falls back to a date once a week has passed, and tolerates junk', () => {
    expect(timeAgo('2026-01-01T00:00:00.000Z', now)).toMatch(/\d/);
    expect(timeAgo('not a date', now)).toBe('');
  });
});

describe('commentThread rendering', () => {
  it('renders each comment with its author and body', () => {
    draw({
      store: storeWith({ [ME]: 'Luke G', [THEM]: 'Ada L' }),
      comments: [comment({ body: 'first' }), comment({ authorId: THEM, body: 'second' })],
    });

    expect(text('.igt-cmt__body')).toEqual(['first', 'second']);
    expect(text('.igt-cmt__author')).toEqual(['Luke G (you)', 'Ada L']);
    // Initials, not the raw email.
    expect(text('.igt-cmt__avatar')).toEqual(['LG', 'AL']);
  });

  it('marks an edited comment', () => {
    draw({ comments: [comment({ edited: true })] });
    expect(text('.igt-cmt__edited')).toEqual(['edited']);
  });

  it('dims a comment that has not been acknowledged and offers it no actions', () => {
    draw({ comments: [comment({ id: 'pending:1' })], canDeleteAny: true });

    expect(host.querySelectorAll('.igt-cmt__row--pending').length).toBe(1);
    expect(text('.igt-cmt__time')).toEqual(['sending…']);
    expect(buttons()).not.toContain('Edit');
    expect(buttons()).not.toContain('Delete');
  });

  it('says so when the thread is empty', () => {
    draw({ comments: [] });
    expect(text('.igt-cmt__empty')).toEqual(['No comments.']);
  });
});

describe('commentThread permissions', () => {
  it('gives a reader no composer', () => {
    draw({ comments: [comment()], canWrite: false });
    expect(host.querySelector('.igt-cmt__composer')).toBeNull();
    expect(host.querySelector('textarea')).toBeNull();
  });

  it('gives a writer a composer', () => {
    draw({ comments: [], canWrite: true });
    expect(host.querySelector('.igt-cmt__composer')).not.toBeNull();
    expect(text('.igt-cmt__empty')).toEqual(['No comments yet.']);
  });

  it('offers Edit only on your own comment, never on someone else s', () => {
    draw({ comments: [comment({ authorId: ME }), comment({ authorId: THEM })], canWrite: true });
    // One Edit (mine) — not two.
    expect(buttons().filter((b) => b === 'Edit')).toHaveLength(1);
  });

  it('offers Delete on your own, and on anyone s once you maintain the project', () => {
    const comments = [comment({ authorId: ME }), comment({ authorId: THEM })];

    draw({ comments, canWrite: true, canDeleteAny: false });
    expect(buttons().filter((b) => b === 'Delete')).toHaveLength(1);

    draw({ comments, canWrite: true, canDeleteAny: true });
    expect(buttons().filter((b) => b === 'Delete')).toHaveLength(2);
    // Still only one Edit: maintaining a project does not license rewriting
    // someone else's words.
    expect(buttons().filter((b) => b === 'Edit')).toHaveLength(1);
  });
});

describe('commentThread interaction', () => {
  it('submits the composer on click and on Ctrl+Enter, but not on a bare Enter', () => {
    const on = noopHandlers();
    draw({ comments: [], canWrite: true, composerDraft: 'hello', on });

    const ta = host.querySelector('.igt-cmt__composer textarea');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(on.submit).not.toHaveBeenCalled();

    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    expect(on.submit).toHaveBeenCalledTimes(1);

    host.querySelector('.igt-cmt__btn--primary').click();
    expect(on.submit).toHaveBeenCalledTimes(2);
  });

  it('disables the submit button until something is typed', () => {
    draw({ comments: [], canWrite: true, composerDraft: '   ' });
    expect(host.querySelector('.igt-cmt__btn--primary').disabled).toBe(true);

    draw({ comments: [], canWrite: true, composerDraft: 'ok' });
    expect(host.querySelector('.igt-cmt__btn--primary').disabled).toBe(false);
  });

  it('reports an edit request with the comment', () => {
    const on = noopHandlers();
    const c = comment();
    draw({ comments: [c], canWrite: true, on });

    host.querySelectorAll('button').forEach((b) => b.textContent.trim() === 'Edit' && b.click());
    expect(on.startEdit).toHaveBeenCalledWith(c);
  });

  it('swaps the row for an editor, and refuses to save an unchanged body', () => {
    const on = noopHandlers();
    const c = comment({ body: 'original' });

    draw({ comments: [c], canWrite: true, editingId: c.id, editDraft: 'original', on });
    expect(host.querySelector('.igt-cmt__row--editing')).not.toBeNull();
    // The body is now in the textarea, so it is no longer rendered as prose.
    expect(host.querySelector('.igt-cmt__body')).toBeNull();
    expect(buttons()).toContain('Cancel');
    const save = [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save');
    expect(save.disabled).toBe(true);

    draw({ comments: [c], canWrite: true, editingId: c.id, editDraft: 'changed', on });
    const save2 = [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save');
    expect(save2.disabled).toBe(false);
    save2.click();
    expect(on.saveEdit).toHaveBeenCalled();
  });

  it('cancels an edit on Escape without letting it reach the grid', () => {
    const on = noopHandlers();
    const c = comment();
    draw({ comments: [c], canWrite: true, editingId: c.id, editDraft: 'x', on });

    const ta = host.querySelector('.igt-cmt__row--editing textarea');
    const evt = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const stop = vi.spyOn(evt, 'stopPropagation');
    ta.dispatchEvent(evt);

    expect(on.cancelEdit).toHaveBeenCalled();
    // Escape must not bubble out to the island, which would close the popover
    // out from under the edit the user just abandoned.
    expect(stop).toHaveBeenCalled();
  });

  it('renders the body through the supplied renderer', () => {
    // The seam Markdown will land in: the view never interprets a body itself.
    draw({
      comments: [comment({ body: 'raw' })],
      renderBody: (b) => `[${b.toUpperCase()}]`,
    });
    expect(text('.igt-cmt__body')).toEqual(['[RAW]']);
  });
});
