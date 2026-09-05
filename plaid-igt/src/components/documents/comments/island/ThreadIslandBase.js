// Shared host state for the lit-html comment islands.
//
// Every place that mounts `commentThread` owns the same transient state: which
// comment is being edited, the edit draft, and one composer draft per thread.
// The Comments tab (every thread in a document or a vocabulary) and the entry
// panel (one entry's thread) both extend this. The interlinear grid keeps its
// own copy inside IgtEditor, whose popover plumbing owns focus and re-render
// timing and cannot share a host.
//
// The comments themselves live in the CommentStore; this never holds one.

import { render, nothing } from 'lit-html';
import { commentThread } from './CommentThread.js';

export class ThreadIslandBase {
  constructor(host, { store, canWrite = false, canDeleteAny = false } = {}) {
    this.host = host;
    this.store = store;
    this.canWrite = canWrite;
    this.canDeleteAny = canDeleteAny;

    this._editingId = null;
    this._editDraft = '';
    this._drafts = new Map(); // entityId -> composer draft

    this._onStoreChange = () => this._render();
    this._unsubStore = store.subscribe(this._onStoreChange);
  }

  destroy() {
    this._unsubStore?.();
    this._unsubStore = null;
    render(nothing, this.host);
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
    this._render();
  }

  async _saveEdit() {
    const id = this._editingId;
    const draft = this._editDraft;
    if (!id || !draft.trim()) return;
    // Close the editor first: the store's update is optimistic, so leaving it
    // open would show a textarea over an already-updated body.
    this._cancelEdit();
    await this.store.edit(id, draft);
  }

  /** Post the composer draft for one thread. `caption` is what the comment is
   * about, in words (see commentAnchors.anchorCaption). */
  async _submit(entityType, entityId, caption) {
    const draft = (this._drafts.get(entityId) || '').trim();
    if (!draft) return;
    this._drafts.set(entityId, '');
    this._render();
    await this.store.post(entityType, entityId, draft, caption);
  }

  async _remove(comment) {
    if (this._editingId === comment.id) this._cancelEdit();
    await this.store.remove(comment.id);
  }

  _handlers(entityType, entityId, caption) {
    return {
      startEdit: (c) => this._startEdit(c),
      cancelEdit: () => this._cancelEdit(),
      changeEdit: (v) => {
        this._editDraft = v;
      },
      saveEdit: () => this._saveEdit(),
      remove: (c) => this._remove(c),
      changeComposer: (v) => {
        this._drafts.set(entityId, v);
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
