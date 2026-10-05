import { html, nothing } from 'lit-html';
import { withReturnedDraft } from '@ui/domain/CommentStore';
import { setUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';
import { commentThread } from '@/components/documents/comments/island/CommentThread.js';
import { buildAnchorIndex, describeAnchor, anchorCaption } from '@/domain/commentAnchors';
import { isVirtualMorphemeId } from '@/domain/virtualMorpheme';
import { notifyWarning } from '@/utils/feedback';

// How long after a refused post its anchor is watched for going (the
// document read again after the refusal), so the typed text can follow it.
const RESCUE_WATCH_MS = 30_000;

// Comment badges on cells and the comment popover they open.
export const comments = {
  //
  // The island draws a badge and opens a popover; the thread itself is the
  // shared `commentThread` view, the same one the lexicon's entry panel mounts.
  // Comment state lives in the CommentStore, not here — this owns only which
  // comment is being edited and what is typed, as every other host does.

  /**
   * @param inline  place the badge in the flow instead of tangent to the right
   *   edge of its positioned ancestor. A sentence field's row has no such
   *   ancestor around the VALUE — the row itself is the containing block — so
   *   an absolute badge there flew to the far end of a full-width row, nowhere
   *   near the field it belongs to.
   */
  _commentBadge(entityType, entityId, label, { inline = false } = {}) {
    const store = this.comments;
    // An unanalyzed word's morpheme is not stored, so nothing can be anchored
    // to it. The word's own badge sits beside it over the same text.
    if (!store || !entityId || isVirtualMorphemeId(entityId)) return nothing;
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
    this._cmtSyncUnsaved();
    this._popoverPos = this._computePopoverPos(anchorEl, 300, this._popWidth('comment'));
    this._render(true);
    // Into the box to type in, or onto Close for someone who can only read:
    // the badge that opened it is behind the popover, and focus left on the
    // page made a comment start with a click.
    const pop = this.container.querySelector('.igt-cmt-pop');
    (
      pop?.querySelector('textarea.igt-cmt__input') ?? pop?.querySelector('.igt-cmt-pop__close')
    )?.focus();
    // The thread's real height is rarely the 300px estimate above.
    this._fitPopover();
  },

  // What is typed into each thread's composer, by entity, kept when the
  // popover closes so reopening it finds the text again.
  _cmtDraftFor(entityId) {
    return (this._cmtDrafts ||= new Map()).get(entityId) || '';
  },

  _cmtSetDraft(entityId, text) {
    (this._cmtDrafts ||= new Map()).set(entityId, text);
    this._cmtSyncUnsaved();
  },

  // Tell the leave question whether anything typed in a comment popover is
  // unsaved: a composer's text (open or not), an edit being typed, or a post
  // or edit still on its way. The island's own teardown unsubscribes from the
  // store, so the registration is dropped there too (wrapped once, here).
  _cmtSyncUnsaved() {
    if (this._destroyed) return;
    if (!this._cmtUnsavedHeld) {
      this._cmtUnsavedHeld = true;
      const unsubscribe = this._unsubComments;
      this._unsubComments = () => {
        unsubscribe?.();
        setUnsavedDraft(this, null);
      };
    }
    const typed = [...(this._cmtDrafts?.values() ?? [])].some((d) => d.trim());
    const edit = this._cmtEditDraft.trim();
    const editing = this._cmtEditingId && edit && edit !== this._cmtEditOriginal;
    setUnsavedDraft(
      this,
      this._cmtSending || typed || editing ? 'The comment you have typed' : null,
      'comments you have typed',
    );
  },

  // The anchors a comment on `entityId` falls back to when it is deleted, the
  // nearest first: a value's word, morpheme or sentence, then theirs. Each
  // `{ entityType, entityId }`, as their badges post.
  _cmtFallbacks(entityId) {
    const index = buildAnchorIndex(this.doc);
    const out = [];
    for (let id = index.get(entityId)?.parentId; id && index.has(id); ) {
      out.push({ entityType: 'token', entityId: id });
      id = index.get(id).parentId;
    }
    return out;
  },

  // A post refused because its anchor was deleted meanwhile (someone cleared
  // the value) keeps its text where a cell opens it again: once the document
  // read after the refusal lacks the anchor, the text moves to the nearest
  // anchor still there (`fallbacks`) and that thread opens with it in its
  // composer. Never left under an id no cell opens.
  _cmtWatchAnchor(entityId, fallbacks) {
    this._cmtUnwatch?.();
    const doc = this.doc;
    if (this._cmtRescue(entityId, fallbacks)) return;
    let seen = doc.dataVersion;
    const unsubscribe = doc.subscribe(() => {
      if (doc.dataVersion === seen) return;
      seen = doc.dataVersion;
      if (this._destroyed || this.doc !== doc || this._cmtRescue(entityId, fallbacks)) stop();
    });
    const timer = setTimeout(() => stop(), RESCUE_WATCH_MS);
    const stop = () => {
      unsubscribe();
      clearTimeout(timer);
      if (this._cmtUnwatch === stop) this._cmtUnwatch = null;
    };
    this._cmtUnwatch = stop;
  },

  // Moves the text typed for `entityId` to the nearest of `fallbacks` the
  // document holds, once it holds no `entityId`, and opens that thread unless
  // another popover is open. With none of them left, or no badge to open,
  // the text is shown in a notice that stays until closed, to copy. Answers whether the anchor is gone.
  _cmtRescue(entityId, fallbacks) {
    const index = buildAnchorIndex(this.doc);
    if (index.has(entityId)) return false;
    const draft = this._cmtDraftFor(entityId);
    if (!draft.trim()) return true;
    this._cmtDrafts.delete(entityId);
    const target = fallbacks.find((f) => index.has(f.entityId));
    if (!target) {
      this._cmtSyncUnsaved();
      notifyWarning(draft, 'Comment not posted', { duration: Infinity });
      return true;
    }
    this._cmtSetDraft(
      target.entityId,
      withReturnedDraft(draft, this._cmtDraftFor(target.entityId)),
    );
    const free = !this._popover || this._popover.entityId === entityId;
    if (free) this._closePopover();
    this._render(true);
    const opener = free && this._openerEl(`comment:${target.entityId}`);
    if (opener) this._openCommentPopover(target.entityType, target.entityId, opener);
    else notifyWarning(draft, 'Comment not posted', { duration: Infinity });
    return true;
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
        dir="ltr"
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
            return;
          }
          // Every other key belongs to what is being typed. The grid's own
          // chords read anything that reached it from a cell: Shift+Right in
          // a draft started gathering a multi-word expression, and the Enter
          // meant as a newline then closed the popover and threw the draft
          // away.
          e.stopPropagation();
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
          composerDraft: this._cmtDraftFor(entityId),
          on: {
            startEdit: (c) => {
              this._cmtEditingId = c.id;
              this._cmtEditDraft = c.body;
              this._cmtEditOriginal = c.body;
              this._render(true);
            },
            cancelEdit: () => {
              this._cmtEditingId = null;
              this._cmtEditDraft = '';
              this._cmtSyncUnsaved();
              this._render(true);
            },
            changeEdit: (v) => {
              this._cmtEditDraft = v;
              this._cmtSyncUnsaved();
            },
            saveEdit: async () => {
              const id = this._cmtEditingId;
              const draft = this._cmtEditDraft;
              if (!id || !draft.trim()) return;
              // Closed at once, since the body shows the edit. A refused edit
              // opens it again on what was typed, while this thread is still
              // the one open and no other edit has started.
              this._cmtEditingId = null;
              this._cmtEditDraft = '';
              this._cmtSending = (this._cmtSending || 0) + 1;
              this._cmtSyncUnsaved();
              this._render(true);
              const ok = await store.edit(id, draft);
              this._cmtSending -= 1;
              const here =
                this._popover?.variant === 'comment' && this._popover.entityId === entityId;
              if (!ok && here && !this._cmtEditingId && !this._destroyed) {
                this._cmtEditingId = id;
                this._cmtEditDraft = draft;
                this._render(true);
              }
              this._cmtSyncUnsaved();
            },
            remove: async (c) => {
              if (!this.confirmDeleteComment) return;
              if (!(await this.confirmDeleteComment(c))) return;
              if (this._cmtEditingId === c.id) this._cmtEditingId = null;
              await store.remove(c.id);
              this._fitPopover();
            },
            changeComposer: (v) => {
              this._cmtSetDraft(entityId, v);
            },
            // The composer empties at once, and a refused post puts the text
            // back in it, in front of anything typed since.
            submit: async () => {
              const draft = this._cmtDraftFor(entityId).trim();
              if (!draft) return;
              // Where the text goes if the anchor is deleted meanwhile, read
              // while the page still holds it.
              const fallbacks = this._cmtFallbacks(entityId);
              this._cmtSending = (this._cmtSending || 0) + 1;
              this._cmtSetDraft(entityId, '');
              this._render(true);
              const created = await store.post(
                entityType,
                entityId,
                draft,
                this._commentCaption(entityType, entityId),
              );
              this._cmtSending -= 1;
              if (!created && !this._destroyed) {
                this._cmtSetDraft(entityId, withReturnedDraft(draft, this._cmtDraftFor(entityId)));
                this._render(true);
                this._cmtWatchAnchor(entityId, fallbacks);
              }
              this._cmtSyncUnsaved();
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
