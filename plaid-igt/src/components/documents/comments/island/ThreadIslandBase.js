// Shared host state for the lit-html comment islands.
//
// Every place that mounts `commentThread` owns the same transient state: which
// comment is being edited, the edit draft, and one composer draft per thread.
// The entry panel (one entry's thread) extends this; the two Comments tabs
// render plaid-ui's React thread instead. The interlinear grid keeps its own
// copy inside IgtEditor, whose popover plumbing owns focus and re-render
// timing and cannot share a host.
//
// The comments themselves live in the CommentStore; this never holds one.

import { render, nothing } from 'lit-html';
import { setUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';
import { withReturnedDraft } from '@ui/domain/CommentStore';
import { commentThread } from './CommentThread.js';

export class ThreadIslandBase {
  /**
   * `confirmDelete` is asked before a comment is removed and must resolve
   * truthy to go ahead. It is REQUIRED, not optional: a comment is unaudited
   * by ruling, so there is no history entry and no restore, and a mis-click on
   * a colleague's thread is permanent. A mount that cannot ask is a mount that
   * does not get to delete, which is why `_remove` refuses without it rather
   * than falling back to deleting.
   */
  constructor(host, { store, canWrite = false, canDeleteAny = false, confirmDelete = null } = {}) {
    this.host = host;
    this.store = store;
    this.canWrite = canWrite;
    this.canDeleteAny = canDeleteAny;
    this.confirmDelete = confirmDelete;

    this._editingId = null;
    this._editDraft = '';
    this._drafts = new Map(); // entityId -> composer draft
    // Posts and edits on their way. What was typed is kept until the server
    // has it, and leaving asks about it until then.
    this._sending = 0;

    this._onStoreChange = () => this._render();
    this._unsubStore = store.subscribe(this._onStoreChange);
  }

  destroy() {
    this._unsubStore?.();
    this._unsubStore = null;
    setUnsavedDraft(this, null);
    render(nothing, this.host);
  }

  // Tell the leave question whether anything typed here is unsaved: a
  // composer with text in it, an edit that changes a comment, or a post or
  // edit still on its way.
  _syncUnsaved() {
    if (!this._unsubStore) {
      setUnsavedDraft(this, null);
      return;
    }
    const editing = this._editingId && this._editDraft.trim();
    const typed = [...this._drafts.values()].some((d) => d.trim());
    setUnsavedDraft(
      this,
      this._sending || editing || typed ? 'The comment you have typed' : null,
      'comments you have typed',
    );
  }

  setPermissions({ canWrite, canDeleteAny }) {
    this.canWrite = canWrite;
    this.canDeleteAny = canDeleteAny;
    this._render();
  }

  // ---- state transitions ---------------------------------------------------

  _startEdit(comment) {
    this._editingId = comment.id;
    this._editDraft = comment.body;
    this._render();
  }

  _cancelEdit() {
    this._editingId = null;
    this._editDraft = '';
    this._syncUnsaved();
    this._render();
  }

  async _saveEdit() {
    const id = this._editingId;
    const draft = this._editDraft;
    if (!id || !draft.trim()) return;
    // Close the editor first: the store's update is optimistic, so leaving it
    // open would show a textarea over an already-updated body. A refused edit
    // opens it again on what was typed, unless another edit is open by then.
    this._sending += 1;
    this._cancelEdit();
    const ok = await this.store.edit(id, draft);
    this._sending -= 1;
    if (!ok && !this._editingId && this._unsubStore) {
      this._editingId = id;
      this._editDraft = draft;
      this._render();
    }
    this._syncUnsaved();
  }

  /** Post the composer draft for one thread. `caption` is what the comment is
   * about, in words (see commentAnchors.anchorCaption). A refused post puts
   * the text back in the composer. */
  async _submit(entityType, entityId, caption) {
    const draft = (this._drafts.get(entityId) || '').trim();
    if (!draft) return;
    this._drafts.set(entityId, '');
    this._sending += 1;
    this._syncUnsaved();
    this._render();
    const created = await this.store.post(entityType, entityId, draft, caption);
    this._sending -= 1;
    if (!created && this._unsubStore) {
      this._drafts.set(entityId, withReturnedDraft(draft, this._drafts.get(entityId) || ''));
      this._render();
    }
    this._syncUnsaved();
  }

  async _remove(comment) {
    if (!this.confirmDelete) return;
    if (!(await this.confirmDelete(comment))) return;
    if (this._editingId === comment.id) this._cancelEdit();
    await this.store.remove(comment.id);
  }

  _handlers(entityType, entityId, caption) {
    return {
      startEdit: (c) => this._startEdit(c),
      cancelEdit: () => this._cancelEdit(),
      changeEdit: (v) => {
        this._editDraft = v;
        this._syncUnsaved();
      },
      saveEdit: () => this._saveEdit(),
      remove: (c) => this._remove(c),
      changeComposer: (v) => {
        this._drafts.set(entityId, v);
        this._syncUnsaved();
      },
      submit: () => this._submit(entityType, entityId, caption),
    };
  }

  // ---- render --------------------------------------------------------------

  /** One thread's view. `canWrite` may be narrowed per thread (an outdated
   * thread takes no new comments: its anchor cannot be posted to). */
  _threadView({ entityType, entityId, comments, caption = null, canWrite = this.canWrite }) {
    return commentThread({
      store: this.store,
      comments,
      canWrite,
      canDeleteAny: this.canDeleteAny,
      editingId: this._editingId,
      editDraft: this._editDraft,
      composerDraft: this._drafts.get(entityId) || '',
      on: this._handlers(entityType, entityId, caption),
    });
  }

  _template() {
    return nothing;
  }

  _render() {
    render(this._template(), this.host);
  }
}
