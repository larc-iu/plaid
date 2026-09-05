// One vocabulary entry's thread, for the entry panel on the vocabulary page.
//
// The same `commentThread` view as everywhere else, with the shared host state
// from ThreadIslandBase. Switching entries keeps the island mounted
// (`setEntry`), so the composer draft of an entry survives a look at another.

import { html, nothing } from 'lit-html';
import { ThreadIslandBase } from './ThreadIslandBase.js';
import './comments-island.css';

export class EntryThreadIsland extends ThreadIslandBase {
  /**
   * @param {HTMLElement} host
   * @param {object} opts
   * @param {import('@/domain/CommentStore').CommentStore} opts.store  the vocabulary's store
   * @param {string} opts.entityId  the entry
   * @param {string|null} [opts.caption]  what a new comment is posted as being about
   */
  constructor(
    host,
    { store, entityId, caption = null, canWrite = false, canDeleteAny = false } = {},
  ) {
    super(host, { store, canWrite, canDeleteAny });
    this.entityId = entityId;
    this.caption = caption;
    this._render();
  }

  setEntry({ entityId, caption = null }) {
    if (entityId !== this.entityId) {
      this._editingId = null;
      this._editDraft = '';
    }
    this.entityId = entityId;
    this.caption = caption;
    this._render();
  }

  _template() {
    const store = this.store;
    if (!this.entityId) return nothing;
    if (!store.isLoaded) {
      return html`<p class="igt-cmts__status">Loading comments…</p>`;
    }
    return html`
      <div class="igt-cmts igt-cmts--entry">
        ${store.error ? html`<p class="igt-cmts__error" role="alert">${store.error}</p>` : nothing}
        ${this._threadView({
          entityType: 'vocab-item',
          entityId: this.entityId,
          comments: store.threadFor(this.entityId),
          caption: this.caption,
        })}
      </div>
    `;
  }
}

if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
