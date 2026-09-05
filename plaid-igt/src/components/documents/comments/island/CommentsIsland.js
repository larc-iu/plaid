// The Comments tab body: every thread in a document, or on a vocabulary's
// entries, in one place.
//
// A vanilla lit-html island for the same reason the grid is one — it renders
// the SAME `commentThread` view the Analyze popover renders, so the thread
// exists once. The React side is a mount wrapper and nothing else.
//
// Threads are labeled by an ANCHOR INDEX (entity id -> words). For a document
// it is derived from the shared IgtDocument; the vocabulary page hands one in.
// A thread whose anchor is no longer in the index is OUTDATED: the comment
// outlived what it was about (a merge, a re-segmentation, a typo fix that
// recreated the word, a deleted entry). It is listed apart, headed by the
// caption it was posted with, and takes no new comments.

import { html, nothing } from 'lit-html';
import { repeat } from 'lit-html/directives/repeat.js';
import { ThreadIslandBase } from './ThreadIslandBase.js';
import { buildAnchorIndex, describeAnchor, anchorCaption } from '@/domain/commentAnchors';
// comments.css rides along with CommentThread.js, which needs it wherever
// it is mounted.
import './comments-island.css';

const DOC_EMPTY =
  'Nothing else in this document has comments yet. Add one from the Analyze tab by hovering a word or a sentence.';

export class CommentsIsland extends ThreadIslandBase {
  /**
   * @param {HTMLElement} host
   * @param {object} opts
   * @param {import('@/domain/CommentStore').CommentStore} opts.store
   * @param {object} [opts.doc]  the IgtDocument: anchors are derived from it and
   *   its own thread is pinned first. Omit on the vocabulary page.
   * @param {() => Map} [opts.anchorIndex]  instead of `doc`: the caller's index
   *   (see commentAnchors.buildEntryAnchorIndex). Called on every render, so
   *   the caller memoizes.
   * @param {Function} [opts.onJumpTo]  called with a descriptor's `jumpId` when
   *   a thread heading is activated (a sentence, or an entry).
   * @param {string} [opts.emptyText]  what to say when nothing has comments.
   * @param {string} [opts.jumpTitle]  the tooltip on a thread heading that navigates.
   */
  constructor(
    host,
    {
      store,
      doc = null,
      anchorIndex = null,
      canWrite = false,
      canDeleteAny = false,
      onJumpTo = null,
      emptyText = null,
      jumpTitle = 'Show in the interlinear editor',
    } = {},
  ) {
    super(host, { store, canWrite, canDeleteAny });
    this.doc = doc;
    this._anchorIndexFn = anchorIndex;
    this.onJumpTo = onJumpTo;
    this.emptyText = emptyText ?? DOC_EMPTY;
    this.jumpTitle = jumpTitle;

    // Anchor labels are derived from the document and only change when its
    // DATA changes, so they are memoized on dataVersion — the same gate the
    // grid uses to avoid rebuilding on every transient emit.
    this._anchorIndex = null;
    this._anchorVersion = -1;

    this._unsubDoc = doc?.subscribe ? doc.subscribe(this._onStoreChange) : null;
    // Someone is looking at every thread, so this is exactly when live updates
    // earn their connection (a no-op for a vocabulary, which has no stream).
    this._releaseLive = store.watchLive();

    this._render();
  }

  destroy() {
    this._releaseLive?.();
    this._releaseLive = null;
    this._unsubDoc?.();
    this._unsubDoc = null;
    super.destroy();
  }

  /** The vocabulary page hands in a fresh index when its entries change. */
  setAnchorIndex(fn) {
    this._anchorIndexFn = fn;
    this._render();
  }

  _anchors() {
    if (this._anchorIndexFn) return this._anchorIndexFn() ?? new Map();
    const version = this.doc?.dataVersion ?? 0;
    if (this._anchorVersion !== version) {
      this._anchorIndex = buildAnchorIndex(this.doc);
      this._anchorVersion = version;
    }
    return this._anchorIndex;
  }

  // ---- render --------------------------------------------------------------

  _thread({ entityType, entityId, comments }) {
    const anchor = describeAnchor(
      this._anchors(),
      entityType,
      entityId,
      comments[0]?.anchorLabel ?? null,
    );
    const outdated = !!anchor.outdated;
    const jumpable = !outdated && this.onJumpTo && anchor.jumpId;

    return html`
      <section
        class=${`igt-cmts__thread${outdated ? ' igt-cmts__thread--outdated' : ''}`}
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
        </header>
        ${this._threadView({
          entityType,
          entityId,
          comments,
          caption: anchorCaption(anchor),
          // Nothing can be posted to an anchor that no longer exists.
          canWrite: this.canWrite && !outdated,
        })}
      </section>
    `;
  }

  _template() {
    const store = this.store;
    if (!store.isLoaded) {
      return html`<p class="igt-cmts__status">Loading comments…</p>`;
    }

    const threads = store.threads();
    const anchors = this._anchors();
    const docId = this.doc?.id ?? null;

    // The document's own thread is pinned first and always present, even when
    // empty: it is the one place to say something about the text as a whole,
    // and it would otherwise have no way in.
    const pinned = docId
      ? (threads.find((t) => t.entityId === docId) ?? {
          entityType: 'document',
          entityId: docId,
          comments: [],
        })
      : null;
    const rest = threads.filter((t) => t.entityId !== docId);
    const current = rest.filter((t) => anchors.has(t.entityId));
    const outdated = rest.filter((t) => !anchors.has(t.entityId));

    return html`
      <div class="igt-cmts">
        ${store.error ? html`<p class="igt-cmts__error" role="alert">${store.error}</p>` : nothing}
        ${pinned ? this._thread(pinned) : nothing}
        ${current.length
          ? html`<div class="igt-cmts__list">
              ${repeat(
                current,
                (t) => t.entityId,
                (t) => this._thread(t),
              )}
            </div>`
          : outdated.length
            ? nothing
            : html`<p class="igt-cmts__status igt-cmts__status--quiet">${this.emptyText}</p>`}
        ${outdated.length
          ? html`<section class="igt-cmts__section" aria-label="Outdated comments">
              <h4 class="igt-cmts__section-title">Outdated</h4>
              <p class="igt-cmts__status igt-cmts__status--quiet">
                On words, values, or entries that no longer exist.
              </p>
              <div class="igt-cmts__list">
                ${repeat(
                  outdated,
                  (t) => t.entityId,
                  (t) => this._thread(t),
                )}
              </div>
            </section>`
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
