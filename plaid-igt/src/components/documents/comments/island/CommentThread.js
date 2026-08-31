// One comment thread, in lit-html.
//
// Framework-agnostic on purpose: this is mounted BOTH inside the Analyze
// island (in a popover anchored to the commented cell) and inside the Comments
// tab. Writing it in React would have meant either a window-event bridge into
// the island or two implementations of the same list.
//
// Pure view. Every piece of state — which comment is being edited, what is
// typed in the composer — lives on the host, which passes it in and gets
// callbacks back. That keeps the host free to own focus and re-render timing,
// which is the whole reason the island exists.

import { html, nothing } from 'lit-html';
import { repeat } from 'lit-html/directives/repeat.js';
import { live } from 'lit-html/directives/live.js';
import { isPending } from '@/domain/CommentStore';

const MAX_BODY = 10000; // matches plaid.sql.comment/max-body-length

// Coarse relative time. A comment thread wants "how long ago", not a
// timestamp; the exact instant is in the title attribute for anyone who cares.
const AGO = [
  [60, 'second', 1],
  [3600, 'minute', 60],
  [86400, 'hour', 3600],
  [604800, 'day', 86400],
];
export function timeAgo(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 45) return 'just now';
  for (const [limit, unit, div] of AGO) {
    if (secs < limit) {
      const n = Math.round(secs / div);
      return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    }
  }
  return new Date(then).toLocaleDateString();
}

// Initials for the avatar chip. Display names here are usually a person's
// name, but fall back to an email local-part when the lookup failed.
function initials(name) {
  const cleaned = String(name || '')
    .split('@')[0]
    .replace(/[._-]+/g, ' ')
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

const submitOnMetaEnter = (fn) => (e) => {
  // Enter alone inserts a newline: a comment is prose, and losing a paragraph
  // break to an accidental submit is worse than reaching for a modifier.
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    fn();
  }
};

function commentRow(comment, ctx) {
  const { store, renderBody, editingId, editDraft, on } = ctx;
  const editing = editingId === comment.id;
  const pending = isPending(comment);
  const mine = comment.authorId === store.currentUserId;
  const name = store.authorName(comment.authorId);

  if (editing) {
    return html`
      <li class="igt-cmt__row igt-cmt__row--editing">
        <textarea
          class="igt-cmt__input"
          rows="3"
          maxlength=${MAX_BODY}
          aria-label="Edit your comment"
          .value=${live(editDraft)}
          @input=${(e) => on.changeEdit(e.target.value)}
          @keydown=${(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              on.cancelEdit();
            } else {
              submitOnMetaEnter(on.saveEdit)(e);
            }
          }}
        ></textarea>
        <div class="igt-cmt__actions">
          <button class="igt-cmt__btn" type="button" @click=${on.cancelEdit}>Cancel</button>
          <button
            class="igt-cmt__btn igt-cmt__btn--primary"
            type="button"
            ?disabled=${!editDraft.trim() || editDraft.trim() === comment.body}
            @click=${on.saveEdit}
          >
            Save
          </button>
        </div>
      </li>
    `;
  }

  return html`
    <li class=${`igt-cmt__row${pending ? ' igt-cmt__row--pending' : ''}`}>
      <div class="igt-cmt__meta">
        <span class="igt-cmt__avatar" aria-hidden="true">${initials(name)}</span>
        <span class="igt-cmt__author"
          >${name}${mine ? html`<span class="igt-cmt__you"> (you)</span>` : nothing}</span
        >
        <time
          class="igt-cmt__time"
          datetime=${comment.createdAt}
          title=${new Date(comment.createdAt).toLocaleString()}
        >
          ${pending ? 'sending…' : timeAgo(comment.createdAt)}
        </time>
        ${comment.edited
          ? html`<span
              class="igt-cmt__edited"
              title=${`Edited ${new Date(comment.updatedAt).toLocaleString()}`}
              >edited</span
            >`
          : nothing}
      </div>
      <div class="igt-cmt__body">${renderBody(comment.body)}</div>
      ${ctx.canEdit(comment) || ctx.canDelete(comment)
        ? html`
            <div class="igt-cmt__actions igt-cmt__actions--rest">
              ${ctx.canEdit(comment)
                ? html`<button
                    class="igt-cmt__btn"
                    type="button"
                    @click=${() => on.startEdit(comment)}
                  >
                    Edit
                  </button>`
                : nothing}
              ${ctx.canDelete(comment)
                ? html`<button
                    class="igt-cmt__btn igt-cmt__btn--danger"
                    type="button"
                    @click=${() => on.remove(comment)}
                  >
                    Delete
                  </button>`
                : nothing}
            </div>
          `
        : nothing}
    </li>
  `;
}

/**
 * Render one thread.
 *
 * @param {object} opts
 * @param {import('@/domain/CommentStore').CommentStore} opts.store
 * @param {Array}  opts.comments      the thread, oldest first
 * @param {boolean} opts.canWrite     project write access (readers may read, not post)
 * @param {boolean} opts.canDeleteAny project maintainer (may delete anyone's)
 * @param {Function} opts.renderBody  body text -> renderable (plain text, or Markdown later)
 * @param {string|null} opts.editingId
 * @param {string} opts.editDraft
 * @param {string} opts.composerDraft
 * @param {object} opts.on            { startEdit cancelEdit changeEdit saveEdit remove
 *                                      changeComposer submit }
 */
export function commentThread(opts) {
  const {
    store,
    comments = [],
    canWrite = false,
    canDeleteAny = false,
    renderBody = (b) => b,
    editingId = null,
    editDraft = '',
    composerDraft = '',
    on,
  } = opts;

  const ctx = {
    store,
    renderBody,
    editingId,
    editDraft,
    on,
    canEdit: (c) => store.canEdit(c),
    // The author may always remove their own; a maintainer may remove any.
    // Never offered for a comment that has not been acknowledged yet.
    canDelete: (c) => !isPending(c) && (store.canEdit(c) || canDeleteAny),
  };

  return html`
    <div class="igt-cmt">
      ${comments.length
        ? html`<ul class="igt-cmt__list">
            ${repeat(
              comments,
              (c) => c.id,
              (c) => commentRow(c, ctx),
            )}
          </ul>`
        : html`<p class="igt-cmt__empty">${canWrite ? 'No comments yet.' : 'No comments.'}</p>`}
      ${canWrite
        ? html`
            <div class="igt-cmt__composer">
              <textarea
                class="igt-cmt__input"
                rows="2"
                maxlength=${MAX_BODY}
                placeholder="Add a comment…"
                aria-label="Add a comment"
                .value=${live(composerDraft)}
                @input=${(e) => on.changeComposer(e.target.value)}
                @keydown=${submitOnMetaEnter(on.submit)}
              ></textarea>
              <div class="igt-cmt__composer-foot">
                <span class="igt-cmt__hint"
                  >${navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl'}+Enter</span
                >
                <button
                  class="igt-cmt__btn igt-cmt__btn--primary"
                  type="button"
                  ?disabled=${!composerDraft.trim()}
                  @click=${on.submit}
                >
                  Comment
                </button>
              </div>
            </div>
          `
        : nothing}
    </div>
  `;
}
