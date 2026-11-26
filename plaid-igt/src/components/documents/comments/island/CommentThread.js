// One comment thread, in lit-html.
//
// Framework-agnostic on purpose: this is mounted BOTH inside the Analyze
// island (in a popover anchored to the commented cell) and in the lexicon's
// entry panel. Writing it in React would have meant either a window-event
// bridge into the island or two implementations of the same list. The Comments
// tabs render plaid-ui's React twin, which reads its rules off the same store.
//
// Pure view. Every piece of state — which comment is being edited, what is
// typed in the composer — lives on the host, which passes it in and gets
// callbacks back. That keeps the host free to own focus and re-render timing,
// which is the whole reason the island exists.

import { html, svg, nothing } from 'lit-html';
import { repeat } from 'lit-html/directives/repeat.js';
import { live } from 'lit-html/directives/live.js';
import { isPending } from '@ui/domain/CommentStore';
import { timeAgo } from '@ui/lib/formatTime.js';
import { initials } from '@ui/lib/initials.js';
import { personDye } from '@ui/domain/projectTartan.js';
import { renderCommentBody } from './renderCommentBody.js';
import './comments.css';
import { isEnter } from '@ui/lib/chords.js';
import { t } from '@ui/lib/i18n.js';

// Keep a composer's submit button in step with what is typed.
//
// Neither host re-renders on keystroke — the island deliberately does not (it
// would fight focus and IME on every character), and the tab follows suit — so
// a `?disabled=${...}` binding evaluated at render time goes stale the moment
// someone types. Toggling the button directly from the input event keeps it
// honest without a render, and keeps the knowledge here in the view rather
// than in both hosts.
//
// The binding this fights with is `live()` for that reason: lit writes an
// attribute only when it differs from the one IT last committed, so after a
// post cleared the draft (empty before, empty after) it would leave the button
// as the keystroke had left it — enabled over an empty composer.
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

// The composer's hint: a format name and key names, the same in any language.
const composerHint = () =>
  `Markdown · ${navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl'}+Enter`; // i18n-ignore: a format name and key names

const submitOnMetaEnter = (fn) => (e) => {
  // Enter alone inserts a newline: a comment is prose, and losing a paragraph
  // break to an accidental submit is worse than reaching for a modifier.
  if (isEnter(e) && (e.metaKey || e.ctrlKey)) {
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
          dir="auto"
          rows="3"
          maxlength=${store.bodyMax}
          aria-label=${t('Edit your comment')}
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
          <button class="igt-cmt__btn" type="button" @click=${on.cancelEdit}>${t('Cancel')}</button>
          <button
            class="igt-cmt__btn igt-cmt__btn--primary"
            type="button"
            ?disabled=${live(!editDraft.trim() || editDraft.trim() === comment.body)}
            @click=${on.saveEdit}
          >
            ${t('Save')}
          </button>
        </div>
      </li>
    `;
  }

  return html`
    <li class=${`igt-cmt__row${pending ? ' igt-cmt__row--pending' : ''}`}>
      <div class="igt-cmt__meta">
        <span
          class="igt-cmt__avatar"
          aria-hidden="true"
          style=${comment.authorId
            ? `background-color: ${personDye(comment.authorId)}; color: #fff`
            : ''}
          >${initials(name)}</span
        >
        <span class="igt-cmt__author"
          >${name}${mine ? html`<span class="igt-cmt__you"> ${t('(you)')}</span>` : nothing}</span
        >
        <time
          class="igt-cmt__time"
          datetime=${comment.createdAt}
          title=${new Date(comment.createdAt).toLocaleString()}
        >
          ${pending ? t('sending…') : timeAgo(comment.createdAt)}
        </time>
        ${comment.edited
          ? html`<span
              class="igt-cmt__edited"
              title=${t('Edited {date}', { date: new Date(comment.updatedAt).toLocaleString() })}
              >${t('edited')}</span
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
                      title=${t('Edit')}
                      aria-label=${t('Edit this comment')}
                      @click=${() => on.startEdit(comment)}
                    >
                      ${PENCIL}
                    </button>`
                  : nothing}
                ${ctx.canDelete(comment)
                  ? html`<button
                      class="igt-cmt__icon igt-cmt__icon--danger"
                      type="button"
                      title=${t('Delete')}
                      aria-label=${t('Delete this comment')}
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
 * @param {import('@ui/domain/CommentStore').CommentStore} opts.store
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
    canEdit: (c) => store.canEdit(c, { canWrite }),
    // The author may remove their own and a maintainer any, while they may
    // write. Never offered for a comment that has not been acknowledged yet.
    canDelete: (c) => store.canDelete(c, { canWrite, canDeleteAny }),
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
        : html`<p class="igt-cmt__empty">
            ${canWrite ? t('No comments yet.') : t('No comments.')}
          </p>`}
      ${canWrite
        ? html`
            <div class="igt-cmt__composer">
              <textarea
                class="igt-cmt__input"
                dir="auto"
                rows="2"
                maxlength=${store.bodyMax}
                placeholder=${t('Add a comment…')}
                aria-label=${t('Add a comment')}
                .value=${live(composerDraft)}
                @input=${onComposerInput(on.changeComposer, (v) => v.trim())}
                @keydown=${submitOnMetaEnter(on.submit)}
              ></textarea>
              <div class="igt-cmt__composer-foot">
                <span class="igt-cmt__hint">${composerHint()}</span>
                <button
                  class="igt-cmt__btn igt-cmt__btn--primary"
                  type="button"
                  ?disabled=${live(!composerDraft.trim())}
                  @click=${on.submit}
                >
                  ${t('Comment')}
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
