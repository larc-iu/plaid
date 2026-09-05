// The Comments tab body: the threads it is handed, one section each.
//
// A vanilla lit-html island for the same reason the grid is one — it renders
// the SAME `commentThread` view the Analyze popover renders, so the thread
// exists once. Which threads, in what order, filtered how, is decided outside
// (domain/commentThreads.js, paged by the React shell with the app's list
// chrome) and handed in through `setThreads`.
//
// A thread starts COLLAPSED: its heading and its latest comment on one line.
// It opens on a click, and stays open while someone is typing in it. The
// pinned thread (a document's own) is always open: it is the one place to
// say something about the text as a whole.

import { html, svg, nothing } from 'lit-html';
import { repeat } from 'lit-html/directives/repeat.js';
import { ThreadIslandBase } from './ThreadIslandBase.js';
import { timeAgo } from './CommentThread.js';
import { plainText } from '@/domain/commentThreads';
import './comments-island.css';

const SNIPPET = 140;

const CHEVRON = svg`<path d="M9 6l6 6-6 6" />`;

export class CommentsIsland extends ThreadIslandBase {
  /**
   * @param {HTMLElement} host
   * @param {object} opts
   * @param {import('@/domain/CommentStore').CommentStore} opts.store
   * @param {Function} [opts.onJumpTo]  called with a thread's `anchor.jumpId`
   *   when its heading is activated (a sentence, or an entry).
   * @param {string} [opts.jumpTitle]  the tooltip on a heading that navigates.
   */
  constructor(
    host,
    {
      store,
      canWrite = false,
      canDeleteAny = false,
      onJumpTo = null,
      jumpTitle = 'Show in the interlinear editor',
    } = {},
  ) {
    super(host, { store, canWrite, canDeleteAny });
    this.onJumpTo = onJumpTo;
    this.jumpTitle = jumpTitle;

    this._pinned = null;
    this._threads = [];
    this._emptyText = '';
    this._expanded = new Set(); // entity ids opened by hand

    // Someone is looking at every thread, so this is exactly when live updates
    // earn their connection (a no-op for a vocabulary, which has no stream).
    this._releaseLive = store.watchLive();
    this._render();
  }

  destroy() {
    this._releaseLive?.();
    this._releaseLive = null;
    super.destroy();
  }

  /**
   * What to show: `pinned` (a described thread or null), `threads` (described,
   * already searched, sorted, and paged), and what to say when `threads` is
   * empty. See domain/commentThreads.js for the thread shape.
   */
  setThreads({ pinned = null, threads = [], emptyText = '' }) {
    this._pinned = pinned;
    this._threads = threads;
    this._emptyText = emptyText;
    this._render();
  }

  // ---- open / closed ---------------------------------------------------------

  _isOpen(t) {
    if (t === this._pinned) return true;
    if (this._expanded.has(t.entityId)) return true;
    // Typing in it, or editing something in it, keeps a thread open.
    if ((this._drafts.get(t.entityId) || '').trim()) return true;
    return !!this._editingId && t.comments.some((c) => c.id === this._editingId);
  }

  _toggle(t) {
    if (this._expanded.has(t.entityId)) this._expanded.delete(t.entityId);
    else this._expanded.add(t.entityId);
    this._render();
  }

  // ---- render --------------------------------------------------------------

  _summary(t) {
    const last = t.comments[t.comments.length - 1];
    if (!last) return nothing;
    const name = this.store.authorName(last.authorId);
    const words = plainText(last.body);
    return html`
      <button
        class="igt-cmts__summary"
        type="button"
        aria-expanded="false"
        title="Open this thread"
        @click=${() => this._toggle(t)}
      >
        <span class="igt-cmts__summary-by">${name}</span>
        <time class="igt-cmts__summary-time" datetime=${last.createdAt}
          >${timeAgo(last.createdAt)}</time
        >
        <span class="igt-cmts__snippet"
          >${words.length > SNIPPET ? `${words.slice(0, SNIPPET - 1)}…` : words}</span
        >
      </button>
    `;
  }

  _thread(t) {
    const { anchor, outdated, entityType, entityId, comments } = t;
    const open = this._isOpen(t);
    const pinned = t === this._pinned;
    const jumpable = !outdated && this.onJumpTo && anchor.jumpId;
    const n = comments.length;

    return html`
      <section
        class=${`igt-cmts__thread${outdated ? ' igt-cmts__thread--outdated' : ''}${
          open ? ' is-open' : ' is-collapsed'
        }`}
        data-entity-id=${entityId}
      >
        <header class="igt-cmts__head">
          ${jumpable
            ? html`<button
                class="igt-cmts__anchor igt-cmts__anchor--link"
                type="button"
                title=${this.jumpTitle}
                @click=${() => this.onJumpTo(anchor.jumpId)}
              >
                ${anchor.label}
              </button>`
            : html`<span class="igt-cmts__anchor">${anchor.label}</span>`}
          <span class=${`igt-cmts__kind${outdated ? ' igt-cmts__kind--outdated' : ''}`}
            >${outdated ? 'outdated' : anchor.kind}</span
          >
          ${anchor.detail ? html`<span class="igt-cmts__detail">${anchor.detail}</span>` : nothing}
          ${pinned
            ? nothing
            : html`<button
                class="igt-cmts__toggle"
                type="button"
                aria-expanded=${open ? 'true' : 'false'}
                title=${open ? 'Collapse' : 'Expand'}
                @click=${() => this._toggle(t)}
              >
                <span class="igt-cmts__count">${n} comment${n === 1 ? '' : 's'}</span>
                <svg
                  class="igt-cmts__chevron"
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
                  ${CHEVRON}
                </svg>
              </button>`}
        </header>
        ${open
          ? this._threadView({
              entityType,
              entityId,
              comments,
              caption: t.caption,
              // Nothing can be posted to an anchor that no longer exists.
              canWrite: this.canWrite && !outdated,
            })
          : this._summary(t)}
      </section>
    `;
  }

  _template() {
    const store = this.store;
    if (!store.isLoaded) {
      return html`<p class="igt-cmts__status">Loading comments…</p>`;
    }
    return html`
      <div class="igt-cmts">
        ${store.error ? html`<p class="igt-cmts__error" role="alert">${store.error}</p>` : nothing}
        ${this._pinned ? this._thread(this._pinned) : nothing}
        ${this._threads.length
          ? html`<div class="igt-cmts__list">
              ${repeat(
                this._threads,
                (t) => t.entityId,
                (t) => this._thread(t),
              )}
            </div>`
          : this._emptyText
            ? html`<p class="igt-cmts__status igt-cmts__status--quiet">${this._emptyText}</p>`
            : nothing}
      </div>
    `;
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
