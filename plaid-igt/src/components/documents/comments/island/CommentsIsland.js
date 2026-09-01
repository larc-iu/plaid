// The Comments tab body: every thread in the document, in one place.
//
// A vanilla lit-html island for the same reason the grid is one — it renders
// the SAME `commentThread` view the Analyze popover renders, so the thread
// exists once. The React side is a mount wrapper and nothing else.
//
// Owns only transient UI state: which comment is being edited, and what is
// typed in each composer. The comments themselves live in the CommentStore,
// and the anchor labels come from the shared IgtDocument.

import { render, html, nothing } from 'lit-html';
import { repeat } from 'lit-html/directives/repeat.js';
import { commentThread } from './CommentThread.js';
import { buildAnchorIndex, describeAnchor } from '@/domain/commentAnchors';
// comments.css rides along with CommentThread.js, which needs it wherever
// it is mounted.
import './comments-island.css';

export class CommentsIsland {
  constructor(host, { store, doc, canWrite = false, canDeleteAny = false, onJumpTo = null } = {}) {
    this.host = host;
    this.store = store;
    this.doc = doc;
    this.canWrite = canWrite;
    this.canDeleteAny = canDeleteAny;
    // Optional: called with a sentence id when a thread heading is activated,
    // so the shell can deep-link into the Analyze grid.
    this.onJumpTo = onJumpTo;

    this._editingId = null;
    this._editDraft = '';
    this._drafts = new Map(); // entityId -> composer draft

    // Anchor labels are derived from the document and only change when its
    // DATA changes, so they are memoized on dataVersion — the same gate the
    // grid uses to avoid rebuilding on every transient emit.
    this._anchorIndex = null;
    this._anchorVersion = -1;

    this._onStoreChange = () => this._render();
    this._unsubStore = store.subscribe(this._onStoreChange);
    this._unsubDoc = doc?.subscribe ? doc.subscribe(this._onStoreChange) : null;
    // Someone is looking at every thread in the document, so this is exactly
    // when live updates earn their connection.
    this._releaseLive = store.watchLive();

    this._render();
  }

  destroy() {
    this._releaseLive?.();
    this._releaseLive = null;
    this._unsubStore?.();
    this._unsubDoc?.();
    render(nothing, this.host);
  }

  setPermissions({ canWrite, canDeleteAny }) {
    this.canWrite = canWrite;
    this.canDeleteAny = canDeleteAny;
    this._render();
  }

  _anchors() {
    const version = this.doc?.dataVersion ?? 0;
    if (this._anchorVersion !== version) {
      this._anchorIndex = buildAnchorIndex(this.doc);
      this._anchorVersion = version;
    }
    return this._anchorIndex;
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

  async _submit(entityType, entityId) {
    const draft = (this._drafts.get(entityId) || '').trim();
    if (!draft) return;
    this._drafts.set(entityId, '');
    this._render();
    await this.store.post(entityType, entityId, draft);
  }

  async _remove(comment) {
    if (this._editingId === comment.id) this._cancelEdit();
    await this.store.remove(comment.id);
  }

  _handlers(entityType, entityId) {
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
      submit: () => this._submit(entityType, entityId),
    };
  }

  // ---- render --------------------------------------------------------------

  _thread({ entityType, entityId, comments }) {
    const anchor = describeAnchor(this._anchors(), entityType, entityId);
    const jumpable = this.onJumpTo && anchor.sentenceId;

    return html`
      <section class="igt-cmts__thread" data-entity-id=${entityId}>
        <header class="igt-cmts__head">
          ${jumpable
            ? html`<button
                class="igt-cmts__anchor igt-cmts__anchor--link"
                type="button"
                title="Show in the interlinear editor"
                @click=${() => this.onJumpTo(anchor.sentenceId)}
              >
                ${anchor.label}
              </button>`
            : html`<span class="igt-cmts__anchor">${anchor.label}</span>`}
          <span class="igt-cmts__kind">${anchor.kind}</span>
          ${anchor.detail ? html`<span class="igt-cmts__detail">${anchor.detail}</span>` : nothing}
        </header>
        ${commentThread({
          store: this.store,
          comments,
          canWrite: this.canWrite,
          canDeleteAny: this.canDeleteAny,
          editingId: this._editingId,
          editDraft: this._editDraft,
          composerDraft: this._drafts.get(entityId) || '',
          on: this._handlers(entityType, entityId),
        })}
      </section>
    `;
  }

  _template() {
    const store = this.store;
    const docId = this.doc?.id;
    const threads = store.threads();

    // The document's own thread is pinned first and always present, even when
    // empty: it is the one place to say something about the text as a whole,
    // and it would otherwise have no way in.
    const docThread = threads.find((t) => t.entityId === docId) ?? {
      entityType: 'document',
      entityId: docId,
      comments: [],
    };
    const rest = threads.filter((t) => t.entityId !== docId);

    if (!store.isLoaded) {
      return html`<p class="igt-cmts__status">Loading comments…</p>`;
    }

    return html`
      <div class="igt-cmts">
        ${store.error ? html`<p class="igt-cmts__error" role="alert">${store.error}</p>` : nothing}
        ${docId ? this._thread(docThread) : nothing}
        ${rest.length
          ? html`<div class="igt-cmts__list">
              ${repeat(
                rest,
                (t) => t.entityId,
                (t) => this._thread(t),
              )}
            </div>`
          : html`<p class="igt-cmts__status igt-cmts__status--quiet">
              Nothing else in this document has comments yet. Add one from the Analyze tab by
              hovering a word or a sentence.
            </p>`}
      </div>
    `;
  }

  _render() {
    render(this._template(), this.host);
  }
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
