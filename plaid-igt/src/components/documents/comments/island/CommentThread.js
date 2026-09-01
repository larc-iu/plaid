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

import { html, svg, nothing } from 'lit-html';
import { repeat } from 'lit-html/directives/repeat.js';
import { live } from 'lit-html/directives/live.js';
import { isPending } from '@/domain/CommentStore';
import { renderCommentBody } from './renderCommentBody.js';
import './comments.css';

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

// Keep a composer's submit button in step with what is typed.
//
// Neither host re-renders on keystroke — the island deliberately does not (it
// would fight focus and IME on every character), and the tab follows suit — so
// a `?disabled=${...}` binding evaluated at render time goes stale the moment
// someone types. Toggling the button directly from the input event keeps it
// honest without a render, and keeps the knowledge here in the view rather
// than in both hosts.
const onComposerInput = (report, isReady) => (e) => {
  report(e.target.value);
  const btn = e.target
    .closest('.igt-cmt__composer, .igt-cmt__row--editing')
    ?.querySelector('.igt-cmt__btn--primary');
  if (btn) btn.disabled = !isReady(e.target.value);
};

// Inline SVG rather than an icon package: the island has no React, so lucide
// is not available to it, and two 12px glyphs are not worth a dependency.
const icon = (paths) =>
  html`<svg
    viewBox="0 0 24 24"
    width="12"
    height="12"
    fill="none"
    stroke="currentColor"
    stroke-width="2.2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    ${paths}
  </svg>`;

const PENCIL = icon(
  svg`<path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />`,
);
const TRASH = icon(svg`<path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" />`);

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
          @input=${onComposerInput(on.changeEdit, (v) => v.trim() && v.trim() !== comment.body)}
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
        <!-- Actions ride the byline rather than sitting under the body: icons
             on the line that already exists cost no extra height, and a thread
             in a popover has little of it to spare. -->
        ${ctx.canEdit(comment) || ctx.canDelete(comment)
          ? html`
              <span class="igt-cmt__actions igt-cmt__actions--rest">
                ${ctx.canEdit(comment)
                  ? html`<button
                      class="igt-cmt__icon"
                      type="button"
                      title="Edit"
                      aria-label="Edit this comment"
                      @click=${() => on.startEdit(comment)}
                    >
                      ${PENCIL}
                    </button>`
                  : nothing}
                ${ctx.canDelete(comment)
                  ? html`<button
                      class="igt-cmt__icon igt-cmt__icon--danger"
                      type="button"
                      title="Delete"
                      aria-label="Delete this comment"
                      @click=${() => on.remove(comment)}
                    >
                      ${TRASH}
                    </button>`
                  : nothing}
              </span>
            `
          : nothing}
      </div>
      <div class="igt-cmt__body">${renderBody(comment.body)}</div>
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
    renderBody = renderCommentBody,
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
                @input=${onComposerInput(on.changeComposer, (v) => v.trim())}
                @keydown=${submitOnMetaEnter(on.submit)}
              ></textarea>
              <div class="igt-cmt__composer-foot">
                <span class="igt-cmt__hint"
                  >Markdown · ${navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl'}+Enter</span
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

// ---------------------------------------------------------------------------
// Hot reload
//
// An island is a plain class, instantiated once when the tab mounts. A hot
// update swaps this MODULE, but the live instance keeps its old prototype, so
// edits to any method here appear to do nothing until the editor is remounted
// — a stale instance silently rendering the previous build. That is a trap:
// you fix something, the page updates, and the bug is still there.
//
// Invalidate instead, so a change to an island forces a full reload.
// ---------------------------------------------------------------------------
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
