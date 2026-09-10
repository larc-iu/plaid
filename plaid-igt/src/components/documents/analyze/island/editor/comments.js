import { html, nothing } from 'lit-html';
import { commentThread } from '@/components/documents/comments/island/CommentThread.js';
import { buildAnchorIndex, describeAnchor, anchorCaption } from '@/domain/commentAnchors';

// Comment badges on cells and the comment popover they open.
export const comments = {
  //
  // The island draws a badge and opens a popover; the thread itself is the
  // shared `commentThread` view, the very same one the Comments tab renders.
  // Comment state lives in the CommentStore, not here — this owns only which
  // comment is being edited and what is typed, exactly as the tab does.

  /**
   * @param inline  place the badge in the flow instead of tangent to the right
   *   edge of its positioned ancestor. A sentence field's row has no such
   *   ancestor around the VALUE — the row itself is the containing block — so
   *   an absolute badge there flew to the far end of a full-width row, nowhere
   *   near the field it belongs to.
   */
  _commentBadge(entityType, entityId, label, { inline = false } = {}) {
    const store = this.comments;
    if (!store || !entityId) return nothing;
    const n = store.countFor(entityId);
    // Nothing to show and nothing to add: a reader (or a past-state view) sees
    // counts but is never offered a control they cannot use.
    if (!n && !this.canComment) return nothing;
    const open = this._popover?.variant === 'comment' && this._popover.entityId === entityId;
    const title = n ? `${n} comment${n === 1 ? '' : 's'} on ${label}` : `Comment on ${label}`;
    return html`
      <button
        type="button"
        class=${`igt-cmt-badge${n ? '' : ' igt-cmt-badge--add'}${open ? ' is-open' : ''}${
          inline ? ' igt-cmt-badge--inline' : ''
        }`}
        data-pop-opener=${`comment:${entityId}`}
        title=${title}
        aria-label=${title}
        @click=${(e) => {
          e.stopPropagation();
          if (open) this._closePopover();
          else this._openCommentPopover(entityType, entityId, e.currentTarget);
        }}
      >
        ${n || '+'}
      </button>
      ${open ? this._commentPopover(entityType, entityId, label) : nothing}
    `;
  },

  // The caption a comment is posted with: the same words the Comments tab
  // heads its thread with, so an outdated comment later reads the way its
  // heading did. The index is memoized on dataVersion, as the tab's is.
  _commentCaption(entityType, entityId) {
    const version = this.doc?.dataVersion ?? 0;
    if (this._cmtAnchorVersion !== version) {
      this._cmtAnchorIndex = buildAnchorIndex(this.doc);
      this._cmtAnchorVersion = version;
    }
    return anchorCaption(describeAnchor(this._cmtAnchorIndex, entityType, entityId));
  },

  _openCommentPopover(entityType, entityId, anchorEl) {
    this._closePopover();
    // Live updates for as long as a thread is on screen — see
    // CommentStore.watchLive for why this is not held for the whole session.
    this._releaseCommentLive = this.comments?.watchLive?.() ?? null;
    this._popover = {
      tokenId: entityId,
      kind: entityType,
      variant: 'comment',
      entityType,
      entityId,
    };
    this._popoverReturnId = `comment:${entityId}`;
    this._cmtEditingId = null;
    this._cmtEditDraft = '';
    this._cmtDraft = '';
    this._popoverPos = this._computePopoverPos(anchorEl, 300, this._popWidth('comment'));
    this._render(true);
    this._focusPopover();
    // The thread's real height is rarely the 300px estimate above.
    this._fitPopover();
  },

  _commentPopover(entityType, entityId, label) {
    const pos = this._popoverPos;
    const posStyle = pos
      ? `position:fixed;left:${pos.left}px;top:${pos.top}px;transform:none;margin-top:0;`
      : '';
    const store = this.comments;
    return html`
      <div
        class="igt-cmt-pop"
        data-igt-pop
        style=${posStyle}
        role="dialog"
        aria-label=${`Comments on ${label}`}
        @click=${(e) => e.stopPropagation()}
        @keydown=${(e) => {
          // Escape closes the popover, not the cell edit behind it.
          if (e.key === 'Escape') {
            e.stopPropagation();
            this._closePopover(true);
          }
        }}
      >
        <header class="igt-cmt-pop__head">
          <span class="igt-cmt-pop__title">${label}</span>
          <button
            class="igt-cmt-pop__close"
            type="button"
            title="Close"
            aria-label="Close comments"
            @click=${() => this._closePopover(true)}
          >
            ×
          </button>
        </header>
        ${commentThread({
          store,
          comments: store.threadFor(entityId),
          canWrite: this.canComment,
          canDeleteAny: this.canDeleteAnyComment,
          editingId: this._cmtEditingId,
          editDraft: this._cmtEditDraft,
          composerDraft: this._cmtDraft || '',
          on: {
            startEdit: (c) => {
              this._cmtEditingId = c.id;
              this._cmtEditDraft = c.body;
              this._render(true);
            },
            cancelEdit: () => {
              this._cmtEditingId = null;
              this._cmtEditDraft = '';
              this._render(true);
            },
            changeEdit: (v) => {
              this._cmtEditDraft = v;
            },
            saveEdit: async () => {
              const id = this._cmtEditingId;
              const draft = this._cmtEditDraft;
              if (!id || !draft.trim()) return;
              this._cmtEditingId = null;
              this._cmtEditDraft = '';
              this._render(true);
              await store.edit(id, draft);
            },
            remove: async (c) => {
              if (this._cmtEditingId === c.id) this._cmtEditingId = null;
              await store.remove(c.id);
              this._fitPopover();
            },
            changeComposer: (v) => {
              this._cmtDraft = v;
            },
            submit: async () => {
              const draft = (this._cmtDraft || '').trim();
              if (!draft) return;
              this._cmtDraft = '';
              this._render(true);
              await store.post(
                entityType,
                entityId,
                draft,
                this._commentCaption(entityType, entityId),
              );
              // A new row makes the popover taller; keep it anchored.
              this._fitPopover();
            },
          },
        })}
      </div>
    `;
  },
};

// See the note at the end of IgtEditor.js: an island's live instance keeps
// its old prototype, so a change here forces a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
