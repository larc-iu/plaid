// Vanilla-JS interlinear ("Analyze") editor island.
//
// Framework-agnostic: consumes an IgtDocument via subscribe()/getSnapshot and
// renders the interlinear grid with lit-html. No React. Mounted by the thin
// AnalyzeIsland.jsx wrapper, but could be mounted by anything.
//
// Why an island: the grid is deeply nested (sentence > token > morpheme >
// annotation) and keystroke-heavy. React reconciliation through that tree
// fights focus/IME on every keystroke. Here we own the DOM: editable cells are
// uncontrolled inputs, we re-render only when the document's *data* actually
// changes (doc.dataVersion, not every emit), and the uncontrolledValue
// directive never overwrites an input the user is actively editing.

import { render, html, nothing } from 'lit-html';
import { repeat } from 'lit-html/directives/repeat.js';
import { live } from 'lit-html/directives/live.js';
import { directive, Directive, PartType } from 'lit-html/directive.js';
import './igt-editor.css';
import { provState, PROV_STATES, confirmedInferred } from '@larc-iu/plaid-client';
import {
  readOrthographies,
  readIgnoredTokens,
  readVocabFields,
  isTokenIgnored,
  trimIgnoredEdges,
} from '@/domain/igtConfig';
import { defaultGuessSource, listAlternatives } from '@/domain/glossGuess';
import { commentThread } from '@/components/documents/comments/island/CommentThread.js';
import { COPY_FORMATS, COPY_FORMAT_STORAGE_KEY, formatSentence } from '@/domain/igtExport';
import {
  morphemeJoiner,
  isStemType,
  FLEX_MORPH_TYPES,
  splitChainText,
} from '@/domain/affixMarkers';
import { buildHomonymIndex } from '@/domain/vocabHomonyms';
import { rankVocabItems } from '@/domain/vocabRank';
import {
  KINDS,
  SLOT_LINK,
  linkPrecedentQueries,
  valuePrecedentQueries,
  createTally,
  foldProject,
  foldDocument,
  precedentCounts,
  precedentForm,
} from '@/domain/precedent';
import { humanizeError, notifyInfo } from '@/utils/feedback';

// Stable empty precedent results, so the tally memo does not rebuild on every
// render while the project queries are still in flight.
const NO_PRECEDENT = Object.freeze({ links: [], values: [] });

// ---- uncontrolledValue: set input.value only when the input is NOT focused.
// Keeps programmatic changes (split/merge form rewrites, reloads) reflected
// while never clobbering text the user is mid-edit on.
class UncontrolledValueDirective extends Directive {
  constructor(partInfo) {
    super(partInfo);
    if (partInfo.type !== PartType.ELEMENT) {
      throw new Error('uncontrolledValue must be used as an element directive');
    }
  }
  update(part, [value]) {
    const el = part.element;
    const v = value ?? '';
    if (el && document.activeElement !== el && el.value !== v) el.value = v;
    return this.render(value);
  }
  render() {
    return nothing;
  }
}
const uncontrolledValue = directive(UncontrolledValueDirective);

const morphFormOf = (m) =>
  m.metadata && Object.prototype.hasOwnProperty.call(m.metadata, 'form')
    ? (m.metadata.form ?? '')
    : (m.content ?? '');

// Display-relevant provenance of an entity's metadata: null for human-made
// material (renders plain), else 'machine' (unverified: violet + dashed) or
// 'verified' (confirmed: quiet). The state doubles as the CSS modifier suffix
// (igt-field--machine, igt-vocab__hint--verified, igt-legend__prov--machine).
// Empty cells are the caller's concern (_field only styles filled values).
const provDisplay = (metadata) => {
  const s = provState(metadata);
  return s === PROV_STATES.HUMAN ? null : s;
};
const provClass = (base, state) => (state ? `${base}--${state}` : '');

const PROV_TITLE = {
  [PROV_STATES.MACHINE]:
    'machine-suggested, unverified. Edit to fix, Ctrl+Enter accepts the whole word',
  [PROV_STATES.VERIFIED]: 'machine-suggested, confirmed',
};
const provTitle = (value, state) => `${value}: ${PROV_TITLE[state]}`;

export class IgtEditor {
  constructor(
    container,
    doc,
    {
      readOnly = false,
      canWriteVocab = null,
      comments = null,
      canComment = false,
      canDeleteAnyComment = false,
    } = {},
  ) {
    // The comment store is the SAME instance the Comments tab renders from, so
    // a comment posted in the grid shows up there without a refetch. Null when
    // comments are unavailable (no signed-in user yet), and the badges simply
    // do not render.
    this.comments = comments;
    this.canComment = canComment;
    this.canDeleteAnyComment = canDeleteAnyComment;
    // Transient comment-popover state: which comment is being edited, its
    // draft, and the composer's draft. Cleared on every open.
    this._cmtEditingId = null;
    this._cmtEditDraft = '';
    this._cmtDraft = '';
    // May the current user add entries to a vocab (needs vocab-maintainer
    // rights on the server)? Linking needs less, so the popover hides its
    // "+ Create" row when this says no. Default: assume yes (dev/tests).
    this.canWriteVocab = typeof canWriteVocab === 'function' ? canWriteVocab : () => true;
    this.container = container;
    this.doc = doc;
    this.readOnly = readOnly;
    this._lastDataVersion = -1;
    this._pendingFocus = null;
    // All doc mutations are funneled through this promise chain so they run
    // strictly sequentially. IgtDocument._withSaving is single-flight (it drops
    // a call that overlaps an in-flight one), and the structural handlers below
    // optimistically touch the DOM — serializing here guarantees no mutation is
    // ever silently dropped while the DOM was already changed (review H1).
    this._opChain = Promise.resolve();
    // Vocab-link popover UI state (not document data — toggling forces a render).
    this._popover = null; // { tokenId, kind } | null
    this._popoverPos = null; // { left, top } fixed-position coords (escapes the grid's overflow clip)
    this._popoverSearch = '';
    // Save-status pill state machine: idle -> saving -> saved(-> idle after a beat).
    // Updated imperatively on every doc emit (incl. isSaving-only emits that don't
    // bump dataVersion), so the indicator reflects in-flight saves without
    // re-rendering the grid and jittering input focus.
    this._statusState = 'idle';
    this._savedTimer = null;
    // Whether the keyboard/scope help legend is expanded.
    this._helpOpen = false;
    // Sentence pagination: big documents (hundreds of sentences) make the full
    // grid multi-second to build, so only one page of sentences is in the DOM.
    this._page = 0;
    // Pluggable gloss-guess source (see domain/glossGuess.js): assign a
    // different (sentences, fields) => { id, guessFor } factory to swap the
    // algorithm (e.g. a service-backed one). The default asks the linked
    // lexicon entry first, then same-form frequency in the document.
    this.guessSourceFactory = defaultGuessSource;
    this._onChange = () => {
      this._syncStatus();
      this._scheduleRender();
    };
    this._unsub = doc.subscribe(this._onChange);
    // Badges and an open thread repaint when a comment lands — including one
    // that arrived from someone else over SSE. Forced, because comments do not
    // touch doc.dataVersion (that is the point of them being separate).
    this._unsubComments = this.comments?.subscribe
      ? this.comments.subscribe(() => this._render(true))
      : null;
    // Per-sentence "Copy as IGT": which sentence's format menu is open, and
    // which sentence just copied (for the "Copied ✓" flash).
    this._copyMenu = null;
    this._copiedFlash = null;
    this._copiedTimer = null;
    this._linkFlash = null;
    this._linkTimer = null;
    // Which annotation rows are minimized, and where the row menu is anchored.
    // Minimizing is a per-project VIEW preference (a field methods course cares
    // about two of twelve rows at a time), so it lives in localStorage rather
    // than project config: it is per-person, not per-project-wide.
    this._collapsedRows = this._loadCollapsedRows();
    // null, or {left, top} viewport coords of the label that opened it. Holding
    // a POSITION rather than a boolean is what keeps the menu on the row that
    // was actually clicked: the label column is re-rendered per sentence, so a
    // boolean opened an identical copy under every sentence at once.
    this._rowMenu = null;
    // The label element the menu hangs off, so it can be re-anchored on scroll.
    this._rowMenuAnchor = null;
    // Any click outside an opener/popover/menu (those stopPropagation) closes it.
    this._onDocClick = () => {
      this._closePopover();
      this._closeCopyMenu();
      this._closeRowMenu();
      this._closeAlts();
    };
    // The alternatives list (Alt+↓ on a cell): { cellKey, active, filter,
    // visible } while open, null otherwise; positioned like the popover.
    this._alts = null;
    this._altsPos = null;
    document.addEventListener('click', this._onDocClick);
    // The popover is position:fixed; scrolling the page or the grid, or
    // resizing, would detach it from its column — re-anchor it to its opener
    // (rAF-throttled) instead of closing. Capture phase catches the grid's
    // own scroll. No-op when no popover is open.
    this._onWinChange = () => {
      this._repositionPopover();
      this._repositionRowMenu();
      this._repositionAlts();
    };
    // Refuse to let a hard reload / tab close silently drop an uncommitted
    // cell edit or a save still in flight (the browser shows its own prompt).
    this._onBeforeUnload = (e) => {
      if (!this._hasUnsavedWork()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', this._onBeforeUnload);
    window.addEventListener('scroll', this._onWinChange, true);
    window.addEventListener('resize', this._onWinChange);
    // Keyboard review of auto-linker suggestions: Ctrl/Cmd+Arrow hops between
    // inferred vocab-link chips; Enter/Backspace confirm/remove the focused one
    // (see _predictionKeydown). Container-level so it works from any cell or chip.
    this.container.addEventListener('keydown', this._predictionKeydown);
    this._render(true);
    this._consumeFocusRequest();
  }

  // Search click-through: a sessionStorage key names a sentence to focus.
  // Page to it (it may be outside the initially rendered page), scroll it into
  // view, and flash it. The key is removed only AFTER the element is actually
  // focused — removing it on read would let React StrictMode's dev-mode
  // throwaway double-mount consume it before the real mount runs.
  _consumeFocusRequest() {
    let req = null;
    try {
      req = JSON.parse(sessionStorage.getItem('igt:focus-sentence') || 'null');
    } catch {
      /* noop */
    }
    if (!req || req.docId !== this.doc.id) return;
    const idx = (this.doc.sentences || []).findIndex((s) => s.id === req.sentenceId);
    if (idx < 0) {
      sessionStorage.removeItem('igt:focus-sentence'); // stale target — drop it
      return;
    }
    const page = Math.floor(idx / IgtEditor.PAGE_SIZE);
    if (page !== this._page) {
      this._page = page;
      this._render(true);
    }
    requestAnimationFrame(() => {
      const el = this.container.querySelector(
        `.igt-sentence[data-sentence-id="${req.sentenceId}"]`,
      );
      if (!el) return; // throwaway mount already torn down — leave the key for the real one
      sessionStorage.removeItem('igt:focus-sentence');
      el.scrollIntoView({ block: 'center' });
      el.classList.add('igt-sentence--flash');
      setTimeout(() => el.classList.remove('igt-sentence--flash'), 2400);
      // Land on the hit word itself (its morpheme form cell, else any of its
      // cells) so a long sentence doesn't leave the user hunting for the word.
      if (typeof req.begin === 'number') {
        const sentence = this.doc.sentences[idx];
        const word = (sentence?.tokens || []).find(
          (t) => t.begin <= req.begin && req.begin < t.end,
        );
        const cell =
          word &&
          (this.container.querySelector(`.igt-morph-field[data-word="${word.id}"]`) ||
            this.container.querySelector(`.igt-field[data-confirm-word="${word.id}"]`));
        if (cell) {
          try {
            cell.focus({ preventScroll: true });
          } catch {
            /* noop */
          }
        }
      }
    });
  }

  // Permissions can change without the document identity changing (a role
  // edit, or leaving a past-state view), so they are synced rather than
  // forcing a remount.
  setCommentPermissions({ canComment, canDeleteAnyComment }) {
    this.canComment = canComment;
    this.canDeleteAnyComment = canDeleteAnyComment;
    this._render(true);
  }

  setReadOnly(ro) {
    if (ro === this.readOnly) return;
    // Flush a focused field's pending blur-commit BEFORE flipping the flag — the
    // commit handlers (_commitField/_commitMorphForm) early-return when
    // readOnly, so blurring after setting it would silently drop the
    // in-progress edit at the read-only/time-travel transition.
    if (this.container.contains(document.activeElement)) document.activeElement.blur();
    this.readOnly = ro;
    // Close any open vocab popover — its openers are disabled in read-only mode.
    this._popover = null;
    this._popoverPos = null;
    this._popoverSearch = '';
    this._render(true);
  }

  destroy() {
    if (this._unsub) this._unsub();
    this._unsub = null;
    if (this._unsubComments) this._unsubComments();
    this._unsubComments = null;
    this._releaseCommentLive?.();
    this._releaseCommentLive = null;
    document.removeEventListener('click', this._onDocClick);
    window.removeEventListener('scroll', this._onWinChange, true);
    window.removeEventListener('resize', this._onWinChange);
    window.removeEventListener('beforeunload', this._onBeforeUnload);
    this.container.removeEventListener('keydown', this._predictionKeydown);
    if (this._repositionRaf) cancelAnimationFrame(this._repositionRaf);
    clearTimeout(this._savedTimer);
    clearTimeout(this._copiedTimer);
    clearTimeout(this._linkTimer);
    render(nothing, this.container);
  }

  // An in-flight save, or a focused cell whose value differs from what it
  // was focused with (i.e. typed but not yet committed by blur/Enter).
  _hasUnsavedWork() {
    if (this.doc.isSaving) return true;
    const el = document.activeElement;
    if (!el || !this.container.contains(el) || !el.classList?.contains('igt-field')) return false;
    return (el.value ?? '') !== (el.dataset.orig ?? '');
  }

  // ---- vocab popover ----
  // ---- comments ------------------------------------------------------------
  //
  // The island draws a badge and opens a popover; the thread itself is the
  // shared `commentThread` view, the very same one the Comments tab renders.
  // Comment state lives in the CommentStore, not here — this owns only which
  // comment is being edited and what is typed, exactly as the tab does.

  _commentBadge(entityType, entityId, label) {
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
        class=${`igt-cmt-badge${n ? '' : ' igt-cmt-badge--add'}${open ? ' is-open' : ''}`}
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
  }

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
  }

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
        <header class="igt-cmt-pop__head">${label}</header>
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
              await store.post(entityType, entityId, draft);
              // A new row makes the popover taller; keep it anchored.
              this._fitPopover();
            },
          },
        })}
      </div>
    `;
  }

  // ---- popover plumbing (variant-agnostic) --------------------------------
  //
  // The anchoring machinery below (position, re-anchor on scroll, fit after
  // render, focus return) is generic; only its SELECTORS were vocab-specific.
  // Rather than rename `.igt-vocab-pop` / `[data-vocab-opener]` — which the
  // vocab e2e specs select on — every popover root also carries `data-igt-pop`
  // and every opener also carries `data-pop-opener="<variant>:<id>"`. The
  // variant is part of the opener key because one word can have both a vocab
  // opener and a comment badge, and an id alone would re-anchor a comment
  // popover onto the vocab chip.

  _popEl() {
    return this.container.querySelector('[data-igt-pop]');
  }

  _openerEl(key) {
    return key ? this.container.querySelector(`[data-pop-opener="${key}"]`) : null;
  }

  // Focus whatever the open popover nominates, once it is in the DOM.
  // (lit-html `autofocus` is unreliable on nodes inserted by a re-render
  // rather than initial parse.)
  _focusPopover() {
    const el = this.container.querySelector('[data-pop-autofocus]');
    if (!el) return;
    try {
      el.focus();
    } catch {
      /* noop */
    }
  }

  // How wide each popover variant is, for the placement math. Must match the
  // width its CSS actually renders at.
  _popWidth(variant = this._popover?.variant) {
    return variant === 'comment' ? 320 : 240;
  }

  _openPopover(tokenId, kind, anchorEl) {
    // Replacing a comment popover with a vocab one bypasses _closePopover, so
    // give up the live-stream claim here too or it leaks.
    this._releaseCommentLive?.();
    this._releaseCommentLive = null;
    this._popover = { tokenId, kind, variant: 'vocab' };
    this._popoverSearch = '';
    this._popoverActiveIndex = 0;
    this._popoverVocabId = null; // re-default to the linked item's vocab each open
    this._popoverCreateEdit = null; // string while the "+ Create" row is being edited
    clearTimeout(this._createClickTimer);
    this._createClickTimer = null;
    this._popoverReturnId = `vocab:${tokenId}`;
    this._popoverPos = this._computePopoverPos(anchorEl, undefined, this._popWidth('vocab'));
    this._ensurePrecedent();
    this._render(true);
    this._focusPopover();
  }

  // Move the highlighted popover row. `total` includes the virtual "create" row
  // when present, so ↓ past the last item lands on Create (keyboard-reachable).
  _movePopoverActive(delta, total) {
    if (total <= 0) return;
    const cur = this._popoverActiveIndex ?? 0;
    this._popoverActiveIndex = Math.max(0, Math.min(total - 1, cur + delta));
    this._render(true);
    // lit-html reuses the search node across this render, so focus is retained;
    // keep the active row visible.
    const active = this._popEl()?.querySelector('.is-active');
    if (active?.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }
  // Keep an open popover glued to its opener while the page/grid scrolls or
  // the window resizes. Patches the fixed coords directly (no re-render per
  // frame); closes only if the opener left the DOM (e.g. a reload re-derived
  // the grid).
  _repositionPopover() {
    if (!this._popover || this._repositionRaf) return;
    this._repositionRaf = requestAnimationFrame(() => {
      this._repositionRaf = null;
      if (!this._popover) return;
      const opener = this._openerEl(this._popoverReturnId);
      const pos = opener ? this._computePopoverPos(opener, undefined, this._popWidth()) : null;
      if (!pos) {
        this._closePopover();
        return;
      }
      this._popoverPos = pos;
      const el = this._popEl();
      if (el) {
        el.style.left = `${pos.left}px`;
        el.style.top = `${pos.top}px`;
      }
    });
  }

  // Position the popover (240px wide) below the opener as fixed coords, clamped
  // to the viewport — so edge columns don't overflow and the grid's overflow-x
  // scroll container can't clip it.
  // `height`: the popover's measured height once rendered (see _fitPopover);
  // before the first paint an estimate is used.
  _computePopoverPos(anchorEl, height = 280, width = 240) {
    const r = anchorEl?.getBoundingClientRect?.();
    if (!r) return null;
    const W = width,
      Hest = height,
      pad = 8;
    let left = r.left + r.width / 2 - W / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - W - pad));
    let top = r.bottom + 4;
    if (top + Hest > window.innerHeight) {
      const above = r.top - Hest - 4;
      // Flip above if it fits; otherwise (viewport too short either way) clamp
      // into view so the search box + create button stay reachable.
      top = above > pad ? above : Math.max(pad, window.innerHeight - Hest - pad);
    }
    return { left, top };
  }
  // returnFocus: send focus back to the opener (for keyboard-driven closes —
  // Escape / Enter-select). Mouse/scroll/outside-click closes must NOT, or they
  // would steal focus from wherever the user clicked.
  _closePopover(returnFocus = false) {
    if (!this._popover) return;
    this._releaseCommentLive?.();
    this._releaseCommentLive = null;
    const returnId = this._popoverReturnId;
    this._popover = null;
    this._popoverPos = null;
    this._popoverSearch = '';
    this._popoverActiveIndex = 0;
    this._popoverCreateEdit = null;
    clearTimeout(this._createClickTimer);
    this._createClickTimer = null;
    this._popoverReturnId = null;
    this._render(true);
    if (returnFocus && returnId != null) {
      const opener = this._openerEl(returnId);
      if (opener) {
        try {
          opener.focus();
        } catch {
          /* noop */
        }
      }
    }
  }
  // ---- auto-linking ----
  // The toolbar button opens the React AutoAnalyzeDialog (rendered by the
  // AnalyzeIsland shell): copy previous analyses → an `analyze` service
  // proposes segmentation + glosses → link to the lexicon (built-in rule or a
  // link-vocab service) — the same service-selection idiom as the
  // Media/Tokenize tabs. The island only dispatches the open request; results
  // land via the shared doc's reload.
  _openAutoAnalyze() {
    window.dispatchEvent(new CustomEvent('igt:auto-analyze-open'));
  }

  // After any popover action the re-render replaces the opener/chip node, so
  // the synchronous focus return in _closePopover is lost; _pendingFocus
  // re-affirms it on the chip after the data render (E2: focus never lost).
  _focusChipAfter(tokenId) {
    this._pendingFocus = { vocabOpener: tokenId };
  }

  _confirmLink(tokenId, returnFocus = false) {
    this._closePopover(returnFocus);
    this._focusChipAfter(tokenId);
    this._run(() => this.doc.confirmVocabLink(tokenId));
  }

  // (The old _suggestMorphemeGloss "copy a gloss on link" write is gone: the
  // gloss-guess system shows the same suggestion as a placeholder in the cell
  // itself, and only writes it — with provenance — when the user confirms.)
  async _toggleVocab(tokenId, item, isLinked, returnFocus = false) {
    this._closePopover(returnFocus);
    this._focusChipAfter(tokenId);
    if (isLinked) {
      await this._run(() => this.doc.unlinkVocab(tokenId));
    } else {
      await this._run(() => this.doc.linkVocab(tokenId, item.id));
    }
  }
  // Turn the "+ Create" row into an inline editor prefilled with `form`
  // (selected, so typing replaces): single click / Enter edit first, a second
  // Enter creates. Double-click creates immediately without the editor.
  _openCreateEdit(form) {
    this._popoverCreateEdit = form ?? '';
    this._render(true);
    const input = this.container.querySelector('.igt-vocab-pop__create-input');
    if (input) {
      try {
        input.focus();
        input.select();
      } catch {
        /* noop */
      }
    }
  }

  _cancelCreateEdit() {
    this._popoverCreateEdit = null;
    this._render(true);
    const search = this.container.querySelector('.igt-vocab-pop__search');
    if (search) {
      try {
        search.focus();
      } catch {
        /* noop */
      }
    }
  }

  async _createVocab(tokenId, vocabId, form, returnFocus = false) {
    this._closePopover(returnFocus);
    if (!form) return;
    this._focusChipAfter(tokenId);
    await this._run(() => this.doc.createAndLinkVocabItem(tokenId, vocabId, form));
  }

  _scheduleRender() {
    if (this.doc.dataVersion === this._lastDataVersion) return;
    this._render();
  }

  // Drive the save-status pill from doc.isSaving (no grid re-render).
  _syncStatus() {
    if (this.doc.isSaving) {
      this._statusState = 'saving';
      clearTimeout(this._savedTimer);
    } else if (this._statusState === 'saving') {
      // Save just finished: flash "Saved" briefly unless it failed (the error
      // banner/toast covers failures).
      if (this.doc.error) {
        this._statusState = 'idle';
      } else {
        this._statusState = 'saved';
        clearTimeout(this._savedTimer);
        this._savedTimer = setTimeout(() => {
          this._statusState = 'idle';
          this._paintStatus();
        }, 1600);
      }
    }
    this._paintStatus();
  }

  _paintStatus() {
    const el = this.container.querySelector('.igt-status');
    if (!el) return;
    const s = this._statusState || 'idle';
    el.dataset.state = s;
    el.textContent = s === 'saving' ? 'Saving…' : s === 'saved' ? 'Saved ✓' : '';
  }

  // Enqueue a doc mutation thunk so it runs after any in-flight one. Returns a
  // promise of the thunk's result (true/false from the doc method) so callers
  // can restore optimistic DOM on failure. Chain never breaks on error.
  _run(fn) {
    const next = this._opChain.then(() => fn());
    this._opChain = next.catch(() => {});
    return next;
  }

  _render(force = false) {
    if (!force && this.doc.dataVersion === this._lastDataVersion) return;
    this._lastDataVersion = this.doc.dataVersion;
    // Defensively clear any stale suppress-commit flags so a sticky flag can't
    // swallow a later legitimate edit on a reused node (review H2).
    this.container.querySelectorAll('[data-suppress-commit]').forEach((el) => {
      delete el.dataset.suppressCommit;
    });
    this.container.classList.toggle('igt-island--readonly', !!this.readOnly);
    // Vocab-linked projects show a hint line under every word/morpheme form;
    // the CSS reserves taller form rows for it (see --igt-form-h).
    this.container.classList.toggle(
      'igt-island--vocab',
      Object.keys(this.doc.vocabularies || {}).length > 0,
    );
    render(this._template(), this.container);
    this._fitPopover();
    this._restorePendingFocus();
    // Size sentence textareas to their content (uncontrolledValue may have just
    // written a programmatic value, e.g. on load / reload).
    this.container
      .querySelectorAll('textarea.igt-field--sentence')
      .forEach((el) => this._autoGrow(el));
  }

  // Re-anchor the open popover with its REAL height: the estimate that placed
  // it may be short (rows, notes, the create editor all vary), which in a short
  // viewport flipped it above the word and let it cover the word itself.
  _fitPopover() {
    if (!this._popover) return;
    const el = this._popEl();
    const opener = this._openerEl(this._popoverReturnId);
    if (!el || !opener) return;
    const pos = this._computePopoverPos(opener, el.offsetHeight || undefined, this._popWidth());
    if (!pos || (pos.left === this._popoverPos?.left && pos.top === this._popoverPos?.top)) return;
    this._popoverPos = pos;
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
  }

  _restorePendingFocus() {
    const pf = this._pendingFocus;
    this._pendingFocus = null;
    if (!pf) return;
    // If the user already moved focus into another field while the structural op
    // was in flight, don't yank it back to the computed target (review: focus theft).
    const active = document.activeElement;
    if (
      active &&
      active !== this.container &&
      this.container.contains(active) &&
      (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
    ) {
      return;
    }
    // Vocab-link review sweep: land focus on the next suggested chip after a
    // confirm/remove re-render (same data-vocab-opener idiom as _closePopover).
    if (pf.vocabOpener != null) {
      const chip = this.container.querySelector(`[data-vocab-opener="${pf.vocabOpener}"]`);
      if (chip) chip.focus();
      return;
    }
    if (pf.cellKey != null) {
      const cell = this.container.querySelector(`[data-cell-key="${pf.cellKey}"]`);
      if (cell) cell.focus();
      return;
    }
    let el = null;
    if (pf.wordId != null && pf.precedence != null) {
      el = this.container.querySelector(
        `.igt-morph-field[data-word="${pf.wordId}"][data-prec="${pf.precedence}"]`,
      );
    }
    if (!el) return;
    el.focus();
    const c =
      pf.cursor === 'end'
        ? el.value.length
        : typeof pf.cursor === 'number'
          ? pf.cursor
          : el.value.length;
    try {
      el.setSelectionRange(c, c);
    } catch {
      /* not selectable */
    }
  }

  // ---- field event helpers ----
  _onFieldFocus = (e) => {
    e.target.dataset.orig = e.target.value;
    try {
      e.target.select();
    } catch {
      /* noop */
    }
  };

  // Morpheme form fields must NOT select-all on focus: the split handler reads
  // the caret position, and a select-all would make a stray '-' split at offset
  // 0 (empty left morpheme) — review M3. Just record the pristine value.
  _onMorphFormFocus = (e) => {
    e.target.dataset.orig = e.target.value;
  };

  _onFieldInput = (e) => {
    const filled = e.target.value !== '';
    e.target.classList.toggle('igt-field--filled', filled);
    e.target.classList.toggle('igt-field--empty', !filled);
    // Typing while the alternatives list is open narrows it by prefix.
    if (this._alts && this._alts.cellKey === e.target.dataset.cellKey) {
      this._alts.filter = e.target.value;
      this._alts.active = 0;
      this._render(true);
    }
  };

  // ---- alternatives list: Alt+↓ on an annotation cell lists every value
  // seen for the form (domain/glossGuess.js listAlternatives), ranked, with
  // its provenance. ↑↓ move, ↵ picks, Esc closes, typing narrows. A pick goes
  // through the guess-adoption path (data-guess-* + blur-commit), so it is
  // written born-verified with the row's source, exactly like adopting a
  // placeholder guess; the cell keeps focus.
  _openAlts(el) {
    const items = typeof el.igtAlts === 'function' ? el.igtAlts() : [];
    if (!items.length) return;
    this._alts = { cellKey: el.dataset.cellKey, active: 0, filter: '', visible: [] };
    this._altsPos = this._computeAltsPos(el, items.length);
    this._render(true);
  }

  _closeAlts() {
    if (!this._alts) return;
    this._alts = null;
    this._altsPos = null;
    this._render(true);
  }

  // Returns true when the key was handled by the list.
  _altsKeydown(e) {
    const el = e.target;
    const open = !!this._alts && this._alts.cellKey === el.dataset.cellKey;
    if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) this._openAlts(el);
      return true;
    }
    if (!open) return false;
    const items = this._alts.visible || [];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length;
      if (n) {
        this._alts.active = (this._alts.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        this._render(true);
      }
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[this._alts.active];
      if (it) this._pickAlt(el, it);
      else this._closeAlts();
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this._closeAlts();
      return true;
    }
    if (e.key === 'Tab') this._closeAlts();
    return false;
  }

  _pickAlt(el, item) {
    this._alts = null;
    this._altsPos = null;
    el.value = item.value;
    el.dataset.guessValue = item.value;
    el.dataset.guessSource = item.source;
    el.dataset.guessConfirmed = '1';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const key = el.dataset.cellKey;
    el.blur(); // commits via _commitField (born-verified) and re-renders
    const same = this.container.querySelector(`[data-cell-key="${key}"]`);
    if (same) same.focus();
  }

  _pickAltByKey(cellKey, item) {
    const el = this.container.querySelector(`[data-cell-key="${cellKey}"]`);
    if (el) this._pickAlt(el, item);
  }

  _computeAltsPos(el, n) {
    const r = el?.getBoundingClientRect?.();
    if (!r) return null;
    const pad = 8;
    const width = Math.max(160, r.width);
    const H = Math.min(n, 8) * 24 + 10;
    const left = Math.max(pad, Math.min(r.left, window.innerWidth - width - pad));
    let top = r.bottom + 2;
    if (top + H > window.innerHeight) {
      const above = r.top - H - 2;
      top = above > pad ? above : Math.max(pad, window.innerHeight - H - pad);
    }
    return { left, top, width };
  }

  _repositionAlts() {
    if (!this._alts) return;
    const el = this.container.querySelector(`[data-cell-key="${this._alts.cellKey}"]`);
    const list = this.container.querySelector('.igt-alts');
    if (!el || !list) return;
    const pos = this._computeAltsPos(el, (this._alts.visible || []).length || 1);
    if (!pos) return;
    this._altsPos = pos;
    list.style.left = `${pos.left}px`;
    list.style.top = `${pos.top}px`;
  }

  _altsTemplate(items, cellKey) {
    const a = this._alts;
    const f = (a.filter || '').toLowerCase();
    const visible = f ? items.filter((it) => it.value.toLowerCase().startsWith(f)) : items;
    a.visible = visible;
    if (a.active >= visible.length) a.active = 0;
    const pos = this._altsPos;
    const posStyle = pos ? `left:${pos.left}px;top:${pos.top}px;min-width:${pos.width}px;` : '';
    const tag = (it) => {
      const parts = [];
      if (it.count) parts.push(`×${it.count}`);
      if (it.entry) parts.push('entry');
      if (it.model) parts.push(it.prob != null ? `model ${Math.round(it.prob * 100)}%` : 'model');
      return parts.join(' · ');
    };
    return html`<div
      class="igt-alts"
      style=${posStyle}
      role="listbox"
      aria-label="Values seen for this form"
      @click=${(e) => e.stopPropagation()}
      @mousedown=${(e) => e.preventDefault()}
    >
      ${visible.length
        ? visible.map(
            (it, i) =>
              html`<div
                class="igt-alts__item ${i === a.active ? 'is-active' : ''}"
                role="option"
                aria-selected=${i === a.active}
                @click=${() => this._pickAltByKey(cellKey, it)}
              >
                <span class="igt-alts__value">${it.value}</span>
                <span class="igt-alts__tag">${tag(it)}</span>
              </div>`,
          )
        : html`<div class="igt-alts__empty">No matching values</div>`}
    </div>`;
  }

  // Guess confirmation: Enter on an empty cell showing a guess adopts the
  // guess into the input value (marked confirmed so the blur-commit attaches
  // provenance) and then proceeds with normal navigation, whose focus change
  // blurs and commits. Tab deliberately does NOT adopt (user decision
  // 2026-08-26): tabbing across a row to reach a cell must never write the
  // guesses it passes over. Typing replaces the guess (it's just a
  // placeholder); plain blur leaves the cell empty — guesses are never written
  // implicitly.
  _maybeConfirmGuess(el) {
    if (el.value === '' && el.dataset.guessValue) {
      el.value = el.dataset.guessValue;
      el.dataset.guessConfirmed = '1';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // Ctrl/Cmd+Enter on any cell of a word column: accept EVERYTHING proposed on
  // that word in one gesture, then hop to the same-tier cell of the NEXT word —
  // the review flow is "glance, Ctrl+Enter, glance, Ctrl+Enter" across a
  // sentence. "Proposed" means what the annotator sees, not where it came
  // from: machine-unverified material is confirmed, and every cell showing a
  // guess is written (the same born-verified write plain Enter makes on one
  // cell). The two look identical on screen by design, so splitting the
  // gesture by which of them a cell holds would only be the data model showing
  // through. The scope split is the real one, and it stays: plain Enter is one
  // cell then the next cell, Ctrl+Enter is one word then the next word.
  //
  // The hop skips the rest of the current word (just accepted wholesale) but
  // does NOT happen when there was nothing to accept: hopping on a no-op reads
  // exactly like a confirmation that never happened, which is how this was
  // first reported.
  _maybeConfirmWord(e) {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return false;
    const wordId = e.target.dataset.confirmWord;
    if (!wordId || this.readOnly) return false;
    e.preventDefault();
    const adoptions = this._wordGuessAdoptions(wordId);
    if (!adoptions.length && !this._wordHasUnverified(wordId)) {
      notifyInfo(
        'Everything here was made by a person already. Enter accepts a guess in one cell.',
        'Nothing to accept on this word',
      );
      return true;
    }
    this._run(() => this.doc.confirmWordAnalysis(wordId, adoptions));
    if (!this._advanceToNextWord(e.target, wordId)) {
      // Last word on the page: commit (blur) but keep the caret here rather
      // than dropping focus to <body> (E2). Re-affirmed after the re-render.
      const key = e.target.dataset.cellKey;
      e.target.blur();
      this._pendingFocus = { cellKey: key };
      const same = key ? this.container.querySelector(`[data-cell-key="${key}"]`) : null;
      if (same) same.focus();
    } else if (adoptions.length) {
      // Adopting reloads the document (new spans), which re-renders the grid
      // out from under the hop target: re-affirm it the way discard does.
      const key = document.activeElement?.dataset?.cellKey;
      if (key) this._pendingFocus = { cellKey: key };
    }
    return true;
  }

  // Every cell in this word's column that is showing a guess right now, as
  // adoption records for confirmWordAnalysis. Read off the rendered cells
  // (they already carry the guess in data-guess-*) rather than recomputed, so
  // "everything proposed on this word" is exactly what the grid is showing.
  // Guesses only render on empty, enabled annotation cells, so `wa:`/`ma:`
  // cell keys are the whole of it: orthographies and morpheme forms never
  // carry one, and sentence fields are their own gesture.
  _wordGuessAdoptions(wordId) {
    const col = this.container.querySelector(`[data-word-col="${wordId}"]`);
    if (!col) return [];
    const out = [];
    for (const el of col.querySelectorAll('.igt-field[data-guess-value]')) {
      if (el.disabled || el.value !== '') continue;
      const [kind, targetId, ...rest] = (el.dataset.cellKey || '').split(':');
      const field = rest.join(':');
      const value = el.dataset.guessValue;
      if ((kind !== 'wa' && kind !== 'ma') || !targetId || !field || !value) continue;
      out.push({
        targetId,
        field,
        value,
        metadata: confirmedInferred(el.dataset.guessSource || 'unknown', { detail: { value } }),
      });
    }
    return out;
  }

  // Whether this word column holds any machine-unverified material — the same
  // selector the review sweep uses to find its next stop.
  _wordHasUnverified(wordId) {
    const col = this.container.querySelector(`[data-word-col="${wordId}"]`);
    return !!col?.querySelector(
      '.igt-field--machine, .igt-token-form--machine, button.igt-vocab__hint--machine:not([disabled])',
    );
  }

  // Ctrl/Cmd+Backspace (or Delete) on any cell of a word column: discard the
  // WHOLE word's machine-unverified proposal — the mirror of Ctrl+Enter for a
  // proposal that is wrong wholesale (a model's segmentation and glosses
  // together). Human and verified pieces survive. Then hops to the next word
  // on the same tier like confirm does, so "Ctrl+Enter, Ctrl+Enter,
  // Ctrl+Backspace, Ctrl+Enter" reads a sentence's proposals left to right.
  // The reload that follows re-renders the island; the hop target is
  // re-affirmed through _pendingFocus.
  _maybeDiscardWord(e) {
    if ((e.key !== 'Backspace' && e.key !== 'Delete') || !(e.ctrlKey || e.metaKey)) return false;
    const wordId = e.target.dataset.confirmWord;
    if (!wordId || this.readOnly) return false;
    e.preventDefault();
    e.target.dataset.suppressCommit = '1';
    this._run(() => this.doc.discardWordAnalysis(wordId));
    if (this._advanceToNextWord(e.target, wordId)) {
      const key = document.activeElement?.dataset?.cellKey;
      if (key) this._pendingFocus = { cellKey: key };
    } else {
      e.target.blur();
    }
    return true;
  }

  // The words on this page with any machine-unverified material (cells or
  // link chips), each represented by its first such element in DOM order:
  // the review sweep's "next word that needs a look" targets.
  _unverifiedWordAnchors() {
    const anchors = [];
    const seen = new Set();
    const els = this.container.querySelectorAll(
      '.igt-field--machine, .igt-token-form--machine, button.igt-vocab__hint--machine:not([disabled])',
    );
    for (const el of els) {
      const col = el.closest('[data-word-col]');
      const wordId = col?.dataset.wordCol;
      if (!wordId || seen.has(wordId)) continue;
      seen.add(wordId);
      // Prefer a machine CELL in the column (where Ctrl+Enter / Ctrl+Backspace
      // act on the word); a column whose only machine material is a link
      // lands on the chip.
      const target =
        col.querySelector('.igt-field--machine') ||
        (el.matches('input, button') ? el : col.querySelector('button.igt-vocab__hint--machine'));
      if (target) anchors.push({ wordId, el: target });
    }
    // Machine-made sentence values (a proposed translation) are stops too,
    // keyed by their cell so the sweep can tell where it is.
    for (const el of this.container.querySelectorAll(
      'textarea.igt-field--sentence.igt-field--machine',
    )) {
      anchors.push({ wordId: `sentence:${el.dataset.cellKey}`, el });
    }
    anchors.sort((a, b) =>
      a.el === b.el
        ? 0
        : a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1,
    );
    return anchors;
  }

  // Jump to the next/previous word with unverified material, relative to the
  // word the focus is in (or from the top/bottom when focus is elsewhere).
  _jumpToUnverifiedWord(dir) {
    const anchors = this._unverifiedWordAnchors();
    if (!anchors.length) return false;
    const active = document.activeElement;
    const curWord =
      active?.closest?.('[data-word-col]')?.dataset.wordCol ??
      (active?.classList?.contains('igt-field--sentence')
        ? `sentence:${active.dataset.cellKey}`
        : null);
    let idx = anchors.findIndex((a) => a.wordId === curWord);
    let target;
    if (idx === -1) {
      if (!active || !this.container.contains(active)) {
        target = dir === 'next' ? anchors[0] : anchors[anchors.length - 1];
      } else {
        // Focus is in a word without unverified material: the next anchor in
        // document order after (or before) it.
        target =
          dir === 'next'
            ? anchors.find(
                (a) => active.compareDocumentPosition(a.el) & Node.DOCUMENT_POSITION_FOLLOWING,
              )
            : [...anchors]
                .reverse()
                .find(
                  (a) => active.compareDocumentPosition(a.el) & Node.DOCUMENT_POSITION_PRECEDING,
                );
      }
    } else {
      target = anchors[dir === 'next' ? idx + 1 : idx - 1];
    }
    if (!target) return false;
    target.el.focus();
    try {
      target.el.select?.();
    } catch {
      /* not selectable */
    }
    return true;
  }

  // Focus the first cell after `el` (DOM order) that sits on the same tier but
  // belongs to a different word column. Words missing the tier (and inert
  // punctuation columns) are skipped naturally; sentence boundaries are
  // crossed. False when there is no later word on this page.
  _advanceToNextWord(el, wordId) {
    const tier = this._tierOf(el);
    const fields = this._navFields();
    const start = fields.indexOf(el);
    if (start === -1) return false;
    for (let i = start + 1; i < fields.length; i++) {
      const f = fields[i];
      if (f.dataset.confirmWord && f.dataset.confirmWord !== wordId && this._tierOf(f) === tier) {
        f.focus();
        try {
          f.select();
        } catch {
          /* not selectable */
        }
        return true;
      }
    }
    return false;
  }

  // ---- vocab-link prediction review ----
  // The auto-linker leaves its suggestions as machine-unverified ("inferred")
  // violet chips. These turn reviewing them into a keyboard sweep, independent
  // of the cell grid (chips are buttons, not .igt-field cells, so _navMove never
  // reaches them): Ctrl/Cmd+Arrow hops chip-to-chip, Enter confirms, Backspace/
  // Delete removes, each advancing to the next — Space/click still opens the
  // popover to change the link.

  // Inferred, actionable chips in DOM (= reading) order.
  _inferredChips() {
    return [...this.container.querySelectorAll('button.igt-vocab__hint--machine:not([disabled])')];
  }

  // The inferred chip after ('next') / before ('prev') the current focus, or
  // null at the ends (no wrap). Anchored on document.activeElement so it works
  // from a field cell or a chip; falls back to the first/last when focus is
  // outside the grid.
  _adjacentChip(dir) {
    const chips = this._inferredChips();
    if (!chips.length) return null;
    const anchor = document.activeElement;
    if (!anchor || !this.container.contains(anchor)) {
      return dir === 'prev' ? chips[chips.length - 1] : chips[0];
    }
    if (dir === 'next') {
      return (
        chips.find(
          (c) =>
            c !== anchor && anchor.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING,
        ) || null
      );
    }
    let prev = null;
    for (const c of chips) {
      if (c !== anchor && anchor.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_PRECEDING)
        prev = c;
    }
    return prev;
  }

  _predictionKeydown = (e) => {
    if (this.readOnly) return;
    // Ctrl/Cmd+Shift+Arrow: hop between WORDS with unverified material (a
    // model's proposals, copied analyses, auto-links) — the whole-word review
    // sweep that pairs with Ctrl+Enter (confirm) and Ctrl+Backspace (discard).
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      if (this._jumpToUnverifiedWord(e.key === 'ArrowDown' ? 'next' : 'prev')) e.preventDefault();
      return;
    }
    // Navigate between suggestions from anywhere in the grid. Only claim the
    // chord when suggestions exist (else leave Cmd+Arrow's default scroll alone).
    if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      if (!this._inferredChips().length) return;
      e.preventDefault();
      const chip = this._adjacentChip(e.key === 'ArrowDown' ? 'next' : 'prev');
      if (chip) chip.focus();
      return;
    }
    // Accept/reject the focused suggestion (Space/click still opens the popover
    // to change it). Only an inferred chip is actionable here.
    const el = document.activeElement;
    if (!el?.classList?.contains('igt-vocab__hint--machine')) return;
    const tokenId = el.dataset.vocabOpener;
    if (!tokenId) return;
    // Ctrl/Cmd+Backspace on a chip discards the WHOLE word's proposal, like
    // on a cell (cells handle it themselves and mark the event consumed).
    if ((e.ctrlKey || e.metaKey) && (e.key === 'Backspace' || e.key === 'Delete')) {
      if (e.defaultPrevented) return;
      const wordId = el.closest('[data-word-col]')?.dataset.wordCol;
      if (!wordId) return;
      e.preventDefault();
      this._run(() => this.doc.discardWordAnalysis(wordId));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      this._reviewLink(() => this.doc.confirmVocabLink(tokenId));
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      this._reviewLink(() => this.doc.unlinkVocab(tokenId));
    }
  };

  // Confirm/remove the focused suggestion, then advance to the next one —
  // captured BEFORE the mutation so the re-render lands focus on it. Confirming/
  // removing one token doesn't touch sibling chips, so the synchronous focus
  // usually survives lit's re-render; _restorePendingFocus re-affirms it.
  _reviewLink(mutate) {
    const next = this._adjacentChip('next');
    if (next) this._pendingFocus = { vocabOpener: next.dataset.vocabOpener };
    this._run(mutate);
    if (next) next.focus();
  }

  _basicKeydown = (e) => {
    if (this._altsKeydown(e)) return;
    if (this._maybeConfirmWord(e)) return;
    if (this._maybeDiscardWord(e)) return;
    // Ctrl/Cmd+Arrow is the review sweep's chord (container listener): leave
    // it alone so the chip hop wins over cell navigation.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) return;
    if (this._maybeArrowOutOfCell(e)) return;
    if (e.key === 'Enter') this._maybeConfirmGuess(e.target);
    if (e.key === 'Enter') {
      // Commit and advance to the next cell in the same tier (the "fill a row
      // across" glossing workflow). Shift+Enter goes back. Falls back to blur
      // (which commits) when there's no next cell.
      e.preventDefault();
      if (!this._navMove(e.target, e.shiftKey ? 'prev' : 'next')) e.target.blur();
    } else if (e.key === 'Tab') {
      // Tab matches Enter: same-tier, not the browser's DOM order (which runs
      // DOWN the column — almost never the glossing flow). When there's no
      // further cell on the tier, fall through to the default so keyboard
      // users can still tab out of the grid.
      if (this._navMove(e.target, e.shiftKey ? 'prev' : 'next')) e.preventDefault();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.target.value = e.target.dataset.orig ?? '';
      e.target.blur();
    } else if (e.key === 'ArrowDown') {
      if (this._navMove(e.target, 'down')) e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      if (this._navMove(e.target, 'up')) e.preventDefault();
    }
  };

  // ← and → leave the cell at the text edges: with the caret collapsed at the
  // start (an empty cell always qualifies) ArrowLeft moves to the previous cell
  // on the tier, and at the end ArrowRight moves to the next — the same
  // same-row movement Enter and Tab make. Inside a value they stay ordinary
  // caret keys, and a selection (focusing a cell selects it) collapses first,
  // so editing text is never hijacked. Without this the arrow model was
  // lopsided: ↑↓ moved rows while ←→ did nothing at all in an empty cell, which
  // reads as an editor that has stopped responding. Modified arrows (word-wise
  // movement, shift-selection) stay with the browser, and an open alternatives
  // list keeps them too — Esc first, then navigate.
  _maybeArrowOutOfCell(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return false;
    const el = e.target;
    if (this._alts && this._alts.cellKey === el.dataset.cellKey) return false;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (start !== end) return false;
    const atEdge = e.key === 'ArrowLeft' ? start === 0 : end === (el.value ?? '').length;
    if (!atEdge) return false;
    if (!this._navMove(el, e.key === 'ArrowLeft' ? 'prev' : 'next')) return false;
    e.preventDefault();
    return true;
  }

  // All focusable editable cells in DOM order (disabled inputs are excluded —
  // they aren't navigation targets).
  _navFields() {
    return [...this.container.querySelectorAll('.igt-field')].filter((el) => !el.disabled);
  }

  // The "tier" of a cell — its kind + field name from data-cell-key
  // (`wa:<id>:Gloss` -> "wa:Gloss"; `mf:<id>` -> "mf:"). Cells on the same
  // tier are the same logical row even when band wrapping puts them at
  // different screen rows.
  _tierOf(el) {
    const key = el.dataset?.cellKey ?? '';
    const parts = key.split(':');
    return `${parts[0]}:${parts.slice(2).join(':')}`;
  }

  // Geometry-based cell navigation: 'next'/'prev' move along the same row (tier),
  // 'down'/'up' move between rows in the same column band. Works across the
  // word/morpheme sub-grid without a coordinate model. Since word columns WRAP
  // into bands, a same-screen-row pass alone dead-ends at a band edge — a
  // second pass continues onto the same TIER in the next/previous band
  // (matching data-cell-key kind+field), and 'down'/'up' fall through to the
  // nearest row across the band boundary. Focusing the target blurs the
  // current input, which commits it. Returns true if it moved.
  _navMove(current, dir) {
    const cr = current.getBoundingClientRect();
    const cx = cr.left + cr.width / 2;
    const cy = cr.top + cr.height / 2;
    const rowTol = 12; // same-row band
    const colTol = 64; // same-column band
    const fields = this._navFields();
    const tier = this._tierOf(current);

    const pick = (score) => {
      let best = null;
      let bestScore = Infinity;
      for (const el of fields) {
        if (el === current) continue;
        const r = el.getBoundingClientRect();
        const s = score(el, r.left + r.width / 2, r.top + r.height / 2);
        if (s != null && s < bestScore) {
          bestScore = s;
          best = el;
        }
      }
      return best;
    };

    // Pass 1: strictly within the current screen row / column band.
    let best = pick((el, ex, ey) => {
      if (dir === 'next') return Math.abs(ey - cy) <= rowTol && ex > cx + 1 ? ex - cx : null;
      if (dir === 'prev') return Math.abs(ey - cy) <= rowTol && ex < cx - 1 ? cx - ex : null;
      if (dir === 'down')
        return ey > cy + 1 && Math.abs(ex - cx) <= colTol ? ey - cy + Math.abs(ex - cx) * 3 : null;
      return ey < cy - 1 && Math.abs(ex - cx) <= colTol ? cy - ey + Math.abs(ex - cx) * 3 : null;
    });

    // Pass 2: cross the band boundary.
    if (!best && (dir === 'next' || dir === 'prev')) {
      // Same tier in a following/preceding band: nearest row in that
      // direction, then the leftmost (next) / rightmost (prev) cell in it.
      best = pick((el, ex, ey) => {
        if (this._tierOf(el) !== tier) return null;
        if (dir === 'next') return ey > cy + rowTol ? (ey - cy) * 10000 + ex : null;
        return ey < cy - rowTol ? (cy - ey) * 10000 + (10000 - ex) : null;
      });
    }
    if (!best && (dir === 'down' || dir === 'up')) {
      // Nearest row beyond the band, then nearest horizontally.
      best = pick((el, ex, ey) => {
        if (dir === 'down') return ey > cy + 1 ? (ey - cy) * 100 + Math.abs(ex - cx) : null;
        return ey < cy - 1 ? (cy - ey) * 100 + Math.abs(ex - cx) : null;
      });
    }

    if (!best) return false;
    best.focus();
    try {
      best.select();
    } catch {
      /* not selectable */
    }
    return true;
  }

  // Commit an annotation/orthography cell on blur if its value changed. Routed
  // through the op chain so it serializes with structural edits. A value
  // adopted from a guess (see _maybeConfirmGuess) carries a born-verified
  // provenance fragment recording the guessed value (provDetail.value, so
  // adoptions per guess source stay countable); a typed value carries none
  // (apply(value, null)).
  _commitField(e, apply) {
    if (this.readOnly) return;
    const el = e.target;
    this._closeAlts(); // leaving the cell dismisses its alternatives list
    if (el.dataset.suppressCommit) {
      delete el.dataset.suppressCommit;
      return;
    }
    const next = el.value;
    const fragment =
      el.dataset.guessConfirmed === '1' && next === el.dataset.guessValue
        ? confirmedInferred(el.dataset.guessSource || 'unknown', { detail: { value: next } })
        : null;
    delete el.dataset.guessConfirmed;
    if (next === (el.dataset.orig ?? '')) return;
    this._runKeepingFocus(el, next, () => apply(next, fragment));
  }

  // Run a cell commit; when it FAILS (server unreachable, conflict…) the doc
  // reloads and re-renders, which used to drop focus to <body> and leave the
  // user to click back. Put the typed value back into the same cell and
  // refocus it so Enter retries (E2: focus is never lost).
  _runKeepingFocus(el, typed, fn) {
    const key = el.dataset.cellKey;
    this._run(fn).then((ok) => {
      if (ok !== false || !key) return;
      const cell = this.container.querySelector(`[data-cell-key="${key}"]`);
      if (!cell) return;
      // Focus first: the focus handler stamps dataset.orig from the current
      // value, and `orig` must stay the SAVED value so Enter sees a change.
      cell.focus();
      cell.value = typed;
      cell.dataset.orig = '';
    });
  }

  _field({
    key,
    value,
    apply,
    extraClass = '',
    sentence = false,
    ariaLabel,
    guess = null,
    prov = null,
    confirmWord = null,
    alternatives = null,
    confirmSentence = null,
    fieldName = null,
  }) {
    const v = value ?? '';
    const filled = v !== '';
    // A guess renders as a styled placeholder: the input VALUE stays empty, so
    // nothing persists unless explicitly confirmed (Enter/Tab — see
    // _maybeConfirmGuess) and stats/jump still see the cell as empty.
    const g = !sentence && !filled && !this.readOnly && guess ? guess : null;
    // Sentence-scoped fields (e.g. free Translation) are full free-text values —
    // an auto-growing textarea that wraps, rather than a one-line scrolling input.
    if (sentence) {
      // Provenance renders exactly as on cells (a proposed translation is
      // violet italic until a person edits or Ctrl+Enter-confirms it).
      const ps = filled ? prov : null;
      return html`<textarea
        class="igt-field igt-field--sentence ${filled
          ? 'igt-field--filled'
          : 'igt-field--empty'} ${provClass('igt-field', ps)} ${extraClass}"
        data-cell-key=${key}
        data-confirm-sentence=${confirmSentence ?? nothing}
        data-field-name=${fieldName ?? nothing}
        aria-label=${ariaLabel ?? nothing}
        title=${ps ? `${provTitle(v, ps)}. Ctrl+Enter confirms it as is` : nothing}
        rows="1"
        ?disabled=${this.readOnly}
        ${uncontrolledValue(v)}
        @focus=${this._onFieldFocus}
        @input=${this._onSentenceInput}
        @keydown=${this._sentenceKeydown}
        @blur=${(e) => this._commitField(e, apply)}
      ></textarea>`;
    }
    const p = filled ? prov : null;
    // Alternatives (Alt+↓): computed per render so the list and the caret
    // affordance track the data; the thunk rides on the element for _openAlts.
    const alts = !this.readOnly && alternatives ? alternatives() : null;
    const nAlts = alts ? alts.length : 0;
    const baseTitle = g
      ? `Guess: ${g.value}. Enter accepts it, Ctrl+Enter accepts the whole word, typing replaces`
      : p
        ? provTitle(v, p)
        : filled
          ? v
          : (ariaLabel ?? null);
    const title =
      nAlts > 1
        ? `${baseTitle ? `${baseTitle}. ` : ''}Alt+↓ lists ${nAlts} values seen for this form`
        : (baseTitle ?? nothing);
    return html`<input
        class="igt-field ${filled ? 'igt-field--filled' : 'igt-field--empty'} ${g
          ? 'igt-field--guess'
          : ''} ${nAlts > 1 ? 'igt-field--alts' : ''} ${provClass('igt-field', p)} ${extraClass}"
        data-cell-key=${key}
        data-guess-value=${g ? g.value : nothing}
        data-guess-source=${g ? g.source : nothing}
        data-confirm-word=${confirmWord ?? nothing}
        aria-label=${ariaLabel ?? nothing}
        title=${title}
        .igtAlts=${alternatives || null}
        placeholder=${g ? g.value : nothing}
        size=${this._fieldSize(g ? g.value : v)}
        ?disabled=${this.readOnly}
        ${uncontrolledValue(v)}
        @focus=${this._onFieldFocus}
        @input=${this._onFieldInput}
        @keydown=${this._basicKeydown}
        @blur=${(e) => this._commitField(e, apply)}
      />${this._alts && this._alts.cellKey === key && alts
        ? this._altsTemplate(alts, key)
        : nothing}`;
  }

  _onSentenceInput = (e) => {
    this._onFieldInput(e);
    this._autoGrow(e.target);
  };

  // Enter commits (the value is logically one translation); Shift+Enter inserts
  // a newline; Tab hops to the same field in the next sentence (fill all
  // translations top to bottom), falling through to the default at the end;
  // Escape reverts.
  _sentenceKeydown = (e) => {
    // Ctrl/Cmd+Arrow is the review sweep's chord (container listener): leave
    // it alone so the chip hop wins over cell navigation.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      // Ctrl+Enter: accept a machine-made value as is (the sentence
      // counterpart of the word gesture) and hop to the same field of the
      // next sentence. An edited value commits instead, which verifies it.
      e.preventDefault();
      const el = e.target;
      const sid = el.dataset.confirmSentence;
      const field = el.dataset.fieldName;
      if (this.readOnly || !sid || !field) return;
      if (el.value === (el.dataset.orig ?? '')) {
        this._run(() => this.doc.confirmSentenceSpan(sid, field));
      }
      if (!this._navMove(el, 'next')) el.blur();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.target.blur();
    } else if (e.key === 'Tab') {
      if (this._navMove(e.target, e.shiftKey ? 'prev' : 'next')) e.preventDefault();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.target.value = e.target.dataset.orig ?? '';
      this._autoGrow(e.target);
      e.target.blur();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Leave the textarea only from its last/first line (caret at the very
      // end/start); inside a multi-line translation the arrows still move the
      // caret. Without this the Translation field trapped ArrowDown.
      const el = e.target;
      const atEnd = el.selectionStart === el.value.length;
      const atStart = el.selectionEnd === 0;
      if ((e.key === 'ArrowDown' && atEnd) || (e.key === 'ArrowUp' && atStart)) {
        if (this._navMove(el, e.key === 'ArrowDown' ? 'down' : 'up')) e.preventDefault();
      }
    }
  };

  _autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  // ---- morpheme form field (adds split/merge/delete key handling) ----
  _morphFormKeydown(morph, word, siblings) {
    return async (e) => {
      // While a split is in flight the destination cell doesn't exist yet, but
      // the (still-focused, not-disabled) source input keeps receiving keys.
      // Buffer them and replay into the new morpheme once it renders, so fast
      // typing ("ngo-ko") never drops characters (review: split key-drop).
      if (this._morphSplit) {
        e.preventDefault();
        const st = this._morphSplit;
        if (e.key === 'Enter' || e.key === 'Tab') st.commitKey = e.key;
        else if (e.key === 'Backspace') st.buffer = st.buffer.slice(0, -1);
        else if ((e.key === '-' || e.key === '=') && !e.altKey && !e.ctrlKey && !e.metaKey) {
          // A further split typed mid-flight ("ngo-ko-mi" fast): remember the
          // boundary (and whether it was a clitic one) instead of inserting a
          // literal, and replay it as another split once the new cell exists.
          st.splits = [...(st.splits || []), { at: st.buffer.length, joiner: e.key }];
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) st.buffer += e.key;
        // Arrows / Escape / etc. mid-flight are swallowed (no meaningful target).
        return;
      }
      if (this._maybeConfirmWord(e)) return;
      if (this._maybeDiscardWord(e)) return;
      // Ctrl/Cmd+Arrow belongs to the review sweep (container listener).
      if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) return;
      if (this._maybeArrowOutOfCell(e)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!this._navMove(e.target, e.shiftKey ? 'prev' : 'next')) e.target.blur();
        return;
      }
      if (e.key === 'Tab') {
        // Same-tier like Enter (next/previous morpheme form); default tab-out
        // when the tier is exhausted.
        if (this._navMove(e.target, e.shiftKey ? 'prev' : 'next')) e.preventDefault();
        return;
      }
      if (e.key === 'ArrowDown') {
        if (this._navMove(e.target, 'down')) e.preventDefault();
        return;
      }
      if (e.key === 'ArrowUp') {
        if (this._navMove(e.target, 'up')) e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.target.value = e.target.dataset.orig ?? '';
        e.target.blur();
        return;
      }
      if (this.readOnly) return;
      const el = e.target;

      // Restore the optimistic DOM if a structural op was dropped/failed.
      const restore = (origValue) => {
        el.disabled = false;
        if (origValue != null) el.value = origValue;
        delete el.dataset.suppressCommit;
        this._pendingFocus = null;
        el.focus();
      };

      // "-" splits at an affix boundary, "=" at a clitic boundary (the clitic
      // side is typed by the shared positional rule, see affixMarkers.js).
      // Ctrl/Cmd+- and Ctrl/Cmd+= are the browser's zoom keys: leave them.
      if ((e.key === '-' || e.key === '=') && !e.ctrlKey && !e.metaKey) {
        const joiner = e.key;
        if (e.altKey) {
          // Alt+- / Alt+= inserts the literal character (reduplication forms,
          // forms that contain a hyphen) rather than splitting the morpheme.
          e.preventDefault();
          const s = el.selectionStart ?? el.value.length;
          const en = el.selectionEnd ?? s;
          el.value = el.value.slice(0, s) + joiner + el.value.slice(en);
          const c = s + 1;
          try {
            el.setSelectionRange(c, c);
          } catch {
            /* noop */
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
        e.preventDefault();
        const pos = el.selectionStart ?? el.value.length;
        const left = el.value.slice(0, pos);
        const right = el.value.slice(pos);
        const orig = el.value;
        el.value = left;
        el.dataset.suppressCommit = '1';
        // Do NOT disable the input: a disabled input stops firing key events and
        // drops keystrokes typed before the new cell renders. Keep it live and
        // buffer those keys (top-of-handler guard) to replay into the new cell.
        // We DON'T use _pendingFocus here: the source input stays focused during
        // flight, which _restorePendingFocus treats as "user moved focus" and
        // bails on — so _applyMorphSplitReplay locates + focuses the new cell.
        this._morphSplit = {
          buffer: '',
          commitKey: null,
          right,
          wordId: word.id,
          precedence: (morph.precedence ?? 1) + 1,
        };
        const ok = await this._run(() => this.doc.splitMorpheme(morph.id, left, right, joiner));
        const split = this._morphSplit;
        this._morphSplit = null;
        if (!ok) {
          restore(orig);
          return;
        }
        // Render has run synchronously by now, so the new cell exists; focus it
        // and flush the buffered keystrokes into it.
        this._applyMorphSplitReplay(split);
        return;
      }

      if (e.key === 'Backspace') {
        const atStart = (el.selectionStart ?? 0) === 0 && (el.selectionEnd ?? 0) === 0;
        const idx = siblings.findIndex((m) => m.id === morph.id);
        // Delete an emptied non-first morpheme.
        if (el.value.trim() === '' && idx > 0) {
          e.preventDefault();
          el.dataset.suppressCommit = '1';
          el.disabled = true;
          this._pendingFocus = {
            wordId: word.id,
            precedence: (morph.precedence ?? 1) - 1,
            cursor: 'end',
          };
          const ok = await this._run(() => this.doc.deleteMorpheme(morph.id));
          el.disabled = false;
          if (!ok) restore(null);
          return;
        }
        // Merge into the previous morpheme when cursor is at the very start.
        if (atStart && idx > 0) {
          e.preventDefault();
          const prev = siblings[idx - 1];
          const prevLen = morphFormOf(prev).length;
          el.dataset.suppressCommit = '1';
          el.disabled = true;
          this._pendingFocus = {
            wordId: word.id,
            precedence: prev.precedence ?? idx,
            cursor: prevLen,
          };
          const ok = await this._run(() => this.doc.mergeMorphemes(morph.id));
          el.disabled = false;
          if (!ok) restore(null);
          return;
        }
      }
    };
  }

  // Flush keystrokes buffered while a split was in flight into the freshly
  // rendered + focused new morpheme cell, then honor a buffered commit key.
  // The morpheme id behind a form cell (`data-cell-key="mf:<id>"`).
  _morphIdOf(el) {
    const key = el?.dataset?.cellKey ?? '';
    return key.startsWith('mf:') ? key.slice(3) : null;
  }

  _applyMorphSplitReplay(split) {
    if (!split) return;
    const el = this.container.querySelector(
      `.igt-morph-field[data-word="${split.wordId}"][data-prec="${split.precedence}"]`,
    );
    if (!el) return; // new cell didn't render as expected — nothing to replay into
    el.focus(); // sets dataset.orig to the current value for commit
    if (split.buffer) {
      // Base is the split's true right-hand form, NOT el.value: an empty-form
      // morpheme renders the parent-text fallback ("the"), which must not be
      // concatenated. Buffered chars were typed after the caret (which sat at
      // the start of `right`), so: buffer + right.
      const base = split.right || '';
      el.value = split.buffer + base;
      const c = split.buffer.length;
      try {
        el.setSelectionRange(c, c);
      } catch {
        /* not selectable */
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      try {
        el.setSelectionRange(0, 0);
      } catch {
        /* not selectable */
      }
    }
    // Further boundaries typed during the flight: split the new cell again at
    // those buffered positions (a real split each, never a literal; a "=" cut
    // keeps its clitic meaning).
    if (split.splits?.length) {
      const text = el.value;
      const byCut = new Map();
      for (const { at, joiner } of split.splits) {
        if (at > 0 && at < text.length && !byCut.has(at)) byCut.set(at, joiner);
      }
      const cuts = [...byCut.keys()].sort((a, b) => a - b);
      if (cuts.length) {
        const segments = [];
        const joiners = [];
        let last = 0;
        for (const c of cuts) {
          segments.push(text.slice(last, c));
          joiners.push(byCut.get(c));
          last = c;
        }
        segments.push(text.slice(last));
        const morphId = this._morphIdOf(el);
        el.dataset.suppressCommit = '1';
        this._pendingFocus = {
          wordId: split.wordId,
          precedence: split.precedence + segments.length - 1,
          cursor: 'end',
        };
        this._run(() => this.doc.splitMorphemeMulti(morphId, segments, { joiners }));
        return;
      }
    }
    // A buffered Enter/Tab commits the new cell and advances (blur → commit).
    if (split.commitKey === 'Enter') {
      if (!this._navMove(el, 'next')) el.blur();
    } else if (split.commitKey === 'Tab') {
      this._navMove(el, 'next');
    }
  }

  // Paste-splitting: pasting text containing "-" or "=" into a morpheme form
  // splits it into a morpheme chain at those boundaries (the bulk-entry idiom
  // from the early single-input prototype — unambiguous here because the paste
  // target is a single known morpheme); "=" boundaries type their clitic side.
  // Boundary-free pastes fall through to the browser default.
  _onMorphPaste(morph, word) {
    return async (e) => {
      if (this.readOnly) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!/[-=]/.test(text)) return;
      e.preventDefault();
      const el = e.target;
      const s = el.selectionStart ?? el.value.length;
      const en = el.selectionEnd ?? s;
      const combined = el.value.slice(0, s) + text + el.value.slice(en);
      const { segments, joiners } = splitChainText(combined);
      if (segments.length <= 1) {
        // All boundaries were leading/trailing/doubled — just insert the cleaned text.
        el.value = segments[0] ?? '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      const orig = el.value;
      el.value = segments[0];
      el.dataset.suppressCommit = '1';
      el.disabled = true;
      this._pendingFocus = {
        wordId: word.id,
        precedence: (morph.precedence ?? 1) + segments.length - 1,
        cursor: 'end',
      };
      const ok = await this._run(() =>
        this.doc.splitMorphemeMulti(morph.id, segments, { joiners }),
      );
      el.disabled = false;
      if (!ok) {
        el.value = orig;
        delete el.dataset.suppressCommit;
        this._pendingFocus = null;
        el.focus();
      }
    };
  }

  _commitMorphForm(e, morphId) {
    if (this.readOnly) return;
    const el = e.target;
    if (el.dataset.suppressCommit) {
      delete el.dataset.suppressCommit;
      return;
    }
    const next = el.value;
    if (next === (el.dataset.orig ?? '')) return;
    this._runKeepingFocus(el, next, () => this.doc.updateMorphemeForm(morphId, next));
  }

  // The gloss-guess source reads the precedent tally (project + this
  // document), which is itself memoized per data version and project fetch;
  // rebuild the source only when that tally object changes, so the many
  // non-data re-renders (popover open/keystroke, paging, help toggle…) reuse
  // it. Rebuilds if the pluggable factory is swapped (e.g. a service-backed
  // source).
  _guessSource(sentences, wordFields, morphFields) {
    const precedent = this._precedentTally();
    if (
      this._guessCacheTally !== precedent ||
      this._guessCacheFactory !== this.guessSourceFactory
    ) {
      this._guessCacheTally = precedent;
      this._guessCacheFactory = this.guessSourceFactory;
      this._guessCache = this.guessSourceFactory({ precedent, sentences, wordFields, morphFields });
    }
    return this._guessCache;
  }

  // ---- templates ----
  _template() {
    const doc = this.doc;
    if (doc.error) {
      // surfaced inline above the grid; toasts handled at the React layer later
    }
    const info = doc.layerInfo;
    if (!info.primaryTokenLayer) {
      return html` <div class="igt-island__empty igt-island__empty--warn">
        <div class="igt-empty__title">This document isn't set up for interlinear analysis yet</div>
        <p class="igt-empty__body">
          No primary <em>word</em> token layer is configured for this project. An administrator
          needs to finish project setup before the interlinear grid can be used.
        </p>
      </div>`;
    }
    const sentences = doc.sentences;
    const hasTokens = sentences.some((s) => s.tokens.length > 0);
    if (!hasTokens) {
      return html` <div class="igt-island__empty">
        <div class="igt-empty__title">Nothing to analyze yet</div>
        <p class="igt-empty__body">
          Interlinear glossing happens here once the text is split into words. Head to the
          <strong>Tokenize</strong> tab to break the baseline text into sentences and words first.
        </p>
        ${this.readOnly
          ? nothing
          : html`<button
              type="button"
              class="igt-empty__cta"
              @click=${(e) => {
                e.stopPropagation();
                this._navigateTab('tokenize');
              }}
            >
              Go to Tokenize →
            </button>`}
      </div>`;
    }

    const orthographies = (readOrthographies(info.primaryTokenLayer.config) || []).map(
      (o) => o.name,
    );
    const wordFields = info.spanLayers.word.map((l) => l.name);
    const morphFields = info.spanLayers.morpheme.map((l) => l.name);
    const sentFields = info.spanLayers.sentence.map((l) => l.name);
    const hasMorphemes = !!info.morphemeTokenLayer;
    const ignoredCfg = readIgnoredTokens(info.primaryTokenLayer.config);
    this._ignoredCfg = ignoredCfg; // the popover trims a new entry's form by it

    // Gloss guesses (pluggable — see domain/glossGuess.js; assign
    // this.guessSourceFactory to swap the algorithm). They read project
    // precedent, fetched once per document (re-rendering when it lands);
    // null in read-only mode so historical views never show suggestions.
    if (!this.readOnly) this._ensurePrecedent();
    const guess = this.readOnly ? null : this._guessSource(sentences, wordFields, morphFields);

    const ctx = {
      orthographies,
      wordFields,
      morphFields,
      sentFields,
      hasMorphemes,
      ignoredCfg,
      guess,
    };
    // _computeRowMenuPos needs the row list to estimate the menu's height, and
    // it runs from a click handler rather than from render.
    this._lastCtx = ctx;

    // One page of sentences in the DOM (see PAGE_SIZE). Sentence numbering
    // stays GLOBAL; cross-page movement is handled by the pager and the search
    // click-through (_consumeFocusRequest pages first).
    const pageCount = Math.max(1, Math.ceil(sentences.length / IgtEditor.PAGE_SIZE));
    this._page = Math.min(Math.max(0, this._page), pageCount - 1);
    const pageStart = this._page * IgtEditor.PAGE_SIZE;
    const pageSentences = sentences.slice(pageStart, pageStart + IgtEditor.PAGE_SIZE);

    return html`
      ${this._toolbar(sentences, ctx, pageCount)} ${this._helpOpen ? this._legend(ctx) : nothing}
      ${doc.error
        ? html`<div class="igt-island__error" role="alert">
            ${humanizeError(doc.error, doc.error)}
          </div>`
        : nothing}
      ${repeat(
        pageSentences,
        (s) => s.id,
        (s, i) => this._sentence(s, pageStart + i, ctx),
      )}
      ${pageCount > 1 ? this._pager(sentences.length, pageCount, 'bottom') : nothing}
      ${this._rowMenu ? this._rowMenuPanel(ctx) : nothing}
    `;
  }

  static PAGE_SIZE = 25;

  _setPage(page, scrollToTop = false) {
    if (page === this._page) return;
    this._page = page;
    this._render(true);
    if (scrollToTop) {
      try {
        this.container.scrollIntoView({ block: 'start' });
      } catch {
        /* noop */
      }
    }
  }

  _pager(total, pageCount, where) {
    const start = this._page * IgtEditor.PAGE_SIZE;
    const end = Math.min(total, start + IgtEditor.PAGE_SIZE);
    const btn = (label, target, title, disabled) =>
      html` <button
        type="button"
        class="igt-pager__btn"
        ?disabled=${disabled}
        title=${title}
        @click=${(e) => {
          e.stopPropagation();
          this._setPage(target, where === 'bottom');
        }}
      >
        ${label}
      </button>`;
    return html`
      <div class="igt-pager">
        ${btn('«', 0, 'First page', this._page === 0)}
        ${btn('‹', this._page - 1, 'Previous page', this._page === 0)}
        <span class="igt-pager__label">${start + 1}–${end} of ${total}</span>
        ${btn('›', this._page + 1, 'Next page', this._page >= pageCount - 1)}
        ${btn('»', pageCount - 1, 'Last page', this._page >= pageCount - 1)}
      </div>
    `;
  }

  // Glossing progress: morphemes with at least one filled gloss field / total.
  _toolbar(sentences, ctx, pageCount = 1) {
    const nSent = sentences.length;
    return html`
      <div class="igt-toolbar">
        <div class="igt-toolbar__left">
          ${pageCount > 1
            ? this._pager(nSent, pageCount, 'top')
            : html`<span class="igt-toolbar__count"
                >${nSent} sentence${nSent === 1 ? '' : 's'}</span
              >`}
          ${!this.readOnly
            ? html`<button
                type="button"
                class="igt-toolbar__btn"
                title="Analyze the document automatically: copy previous analyses, have a service propose segmentation and glosses, and link to the lexicon. Proposals show in violet until you confirm them."
                @click=${(e) => {
                  e.stopPropagation();
                  this._openAutoAnalyze();
                }}
              >
                Auto-analyze…
              </button>`
            : nothing}
        </div>
        <div class="igt-toolbar__right">
          <span
            class="igt-status"
            role="status"
            aria-live="polite"
            data-state=${this._statusState || 'idle'}
          ></span>
          <button
            type="button"
            class="igt-help-btn"
            aria-expanded=${this._helpOpen ? 'true' : 'false'}
            aria-label="Keyboard & scope help"
            title="Keyboard & scope help"
            @click=${(e) => {
              e.stopPropagation();
              this._toggleHelp();
            }}
          >
            ?
          </button>
        </div>
      </div>
    `;
  }

  _legend(ctx) {
    return html`
      <div class="igt-legend">
        <div class="igt-legend__row">
          <strong>Scopes</strong>
          <span class="igt-legend__chip igt-legend__chip--orth">Orthography</span>
          <span class="igt-legend__chip igt-legend__chip--word">Word</span>
          ${ctx.hasMorphemes
            ? html`<span class="igt-legend__chip igt-legend__chip--morph">Morpheme</span>`
            : nothing}
          <span class="igt-legend__chip igt-legend__chip--sent">Sentence</span>
        </div>
        <div class="igt-legend__row">
          <strong>Navigate</strong>
          <span
            ><kbd>Enter</kbd>/<kbd>Tab</kbd> next cell in the same row · <kbd>⇧</kbd>+ previous ·
            <kbd>↑</kbd><kbd>↓</kbd> move rows · <kbd>←</kbd><kbd>→</kbd> move along the row from
            the ends of a value · <kbd>Esc</kbd> cancel edit</span
          >
        </div>
        ${ctx.hasMorphemes
          ? html` <div class="igt-legend__row">
              <strong>Morphemes</strong>
              <span
                >type <kbd>-</kbd> to split, <kbd>=</kbd> to split at a clitic (pasting
                <em>a-b=c</em> splits too) · <kbd>⌫</kbd> at start merges with previous ·
                <kbd>Alt</kbd>+<kbd>-</kbd> / <kbd>Alt</kbd>+<kbd>=</kbd> literal character</span
              >
            </div>`
          : nothing}
        <div class="igt-legend__row">
          <strong>Guesses</strong>
          <span
            >violet italic values are guesses from the linked entry or from matching forms.
            <kbd>↵</kbd> accepts this cell, <kbd>Ctrl</kbd>+<kbd>↵</kbd> accepts the whole word,
            typing replaces, leaving the cell discards · <kbd>Alt</kbd>+<kbd>↓</kbd> lists every
            value seen for the form, with counts</span
          >
        </div>
        <div class="igt-legend__row">
          <strong>Provenance</strong>
          <span
            ><span class="igt-legend__prov igt-legend__prov--machine">violet italic</span> =
            machine-made, unverified ·
            <span class="igt-legend__prov igt-legend__prov--verified">violet underline</span> =
            machine-made, confirmed by a person · plain = made by a person · editing a value
            confirms it · <kbd>Ctrl</kbd>+<kbd>↵</kbd> accepts everything proposed on a word
            (machine values and guesses alike) and jumps to the next · <kbd>Ctrl</kbd>+<kbd>⌫</kbd>
            discards a word's unverified proposal · <kbd>Ctrl</kbd>+<kbd>⇧</kbd>+<kbd>↑</kbd
            ><kbd>↓</kbd> jump between words and translations with unverified proposals</span
          >
        </div>
        <div class="igt-legend__row">
          <strong>Lexicon</strong>
          <span
            >hover a word or morpheme and click <em>+ link</em> to link it to a lexicon entry ·
            <em>Auto-analyze</em> copies previous analyses, lets a service propose segmentation and
            glosses, and links what follows project precedent or matches one entry. Violet links are
            auto-made; open one and click it (or <em>confirm</em>) to approve</span
          >
        </div>
        <div class="igt-legend__row">
          <strong>Review links</strong>
          <span
            ><kbd>Ctrl</kbd>+<kbd>↑</kbd><kbd>↓</kbd> jump between suggested (violet) links · on
            one: <kbd>↵</kbd> confirm · <kbd>⌫</kbd> remove · <kbd>Space</kbd> change. Each jumps to
            the next</span
          >
        </div>
      </div>
    `;
  }

  _toggleHelp() {
    this._helpOpen = !this._helpOpen;
    this._render(true);
  }

  // Ask the React shell (DocumentDetail) to switch the active editor tab. The
  // island is framework-agnostic, so this goes out as a DOM CustomEvent the
  // shell listens for, rather than calling a router directly.
  _navigateTab(tab) {
    window.dispatchEvent(new CustomEvent('igt:navigate-tab', { detail: { tab } }));
  }

  // ---- "Copy as IGT" -------------------------------------------------------
  // Non-mutating, so it works in read-only/historical views too. The main
  // button copies in the user's favorite format (persisted in localStorage);
  // the caret opens a format menu, and picking a format copies AND becomes
  // the new favorite.
  _favoriteCopyFormat() {
    const stored = localStorage.getItem(COPY_FORMAT_STORAGE_KEY);
    return COPY_FORMATS.some((f) => f.id === stored) ? stored : 'plain';
  }

  _closeCopyMenu() {
    if (this._copyMenu == null) return;
    this._copyMenu = null;
    this._render(true);
  }

  async _copySentence(sentence, ctx, format) {
    const fields = {
      morphFields: ctx.morphFields,
      wordFields: ctx.wordFields,
      sentFields: ctx.sentFields,
    };
    const text = formatSentence(sentence, fields, format);
    await this._writeClipboard(text);
    this._copyMenu = null;
    this._copiedFlash = sentence.id;
    clearTimeout(this._copiedTimer);
    this._copiedTimer = setTimeout(() => {
      this._copiedFlash = null;
      this._render(true);
    }, 1400);
    this._render(true);
  }

  async _writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API unavailable (insecure context): textarea fallback.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } finally {
        ta.remove();
      }
    }
  }

  // A shareable deep link to one sentence: the Analyze tab of this document,
  // focused on this sentence (DocumentDetail reads ?focusSentence= and the
  // island scrolls to it and flashes it — see _consumeFocusRequest).
  //
  // Built off location.origin + pathname, NOT a hard-coded root: in the packaged
  // jar the app is served under /igt/, and the routes live in the hash. Same
  // reason PlaidClient.inviteUrl takes the app URL from the caller.
  _sentenceLink(sentence) {
    const { origin, pathname } = window.location;
    const base = `${origin}${pathname}`.replace(/\/$/, '');
    const projectId = this.doc?.project?.id ?? this.doc?._projectId;
    return (
      `${base}/#/projects/${projectId}/documents/${this.doc.id}` +
      `?tab=analyze&focusSentence=${encodeURIComponent(sentence.id)}`
    );
  }

  async _copySentenceLink(sentence) {
    await this._writeClipboard(this._sentenceLink(sentence));
    this._linkFlash = sentence.id;
    clearTimeout(this._linkTimer);
    this._linkTimer = setTimeout(() => {
      this._linkFlash = null;
      this._render(true);
    }, 1400);
    this._render(true);
  }

  _copyControl(sentence, ctx) {
    const fav = this._favoriteCopyFormat();
    const favLabel = COPY_FORMATS.find((f) => f.id === fav)?.label ?? fav;
    const open = this._copyMenu === sentence.id;
    const copied = this._copiedFlash === sentence.id;
    const linked = this._linkFlash === sentence.id;
    return html`
      <div class="igt-copy" @click=${(e) => e.stopPropagation()}>
        <button
          type="button"
          class="igt-copy__link ${linked ? 'is-copied' : ''}"
          title="Copy a link to this sentence"
          aria-label="Copy a link to this sentence"
          @click=${() => this._copySentenceLink(sentence)}
        >
          ${linked
            ? html`<span class="igt-copy__linkok" aria-hidden="true">✓</span>`
            : html`<svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
                <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
              </svg>`}
        </button>
        <button
          type="button"
          class="igt-copy__btn"
          title=${`Copy as IGT: ${favLabel}`}
          @click=${() => this._copySentence(sentence, ctx, fav)}
        >
          ${copied ? 'Copied ✓' : 'Copy'}
        </button>
        <button
          type="button"
          class="igt-copy__caret"
          aria-label="Choose copy format"
          aria-expanded=${open ? 'true' : 'false'}
          @click=${() => {
            this._copyMenu = open ? null : sentence.id;
            this._render(true);
          }}
        >
          ▾
        </button>
        ${open
          ? html` <div class="igt-copy__menu" role="menu">
              ${COPY_FORMATS.map(
                (f) => html`
                  <button
                    type="button"
                    class="igt-copy__item ${f.id === fav ? 'is-fav' : ''}"
                    role="menuitem"
                    @click=${() => {
                      localStorage.setItem(COPY_FORMAT_STORAGE_KEY, f.id);
                      this._copySentence(sentence, ctx, f.id);
                    }}
                  >
                    <span>${f.label}</span>
                    ${f.id === fav ? html`<span class="igt-copy__fav">★</span>` : nothing}
                  </button>
                `,
              )}
              <div class="igt-copy__hint">picking a format makes it the default</div>
            </div>`
          : nothing}
      </div>
    `;
  }

  _sentence(sentence, index, ctx) {
    // Render word columns interleaved with the baseline text that no word token
    // covers (punctuation, stray characters): each such run gets a slim,
    // non-editable "gap" column so it stays visible in its true position.
    // Whitespace-only gaps (ordinary inter-word spacing) are dropped.
    const cols = sentence.pieces.filter((p) => p.isToken || (p.content || '').trim() !== '');
    return html`
      <div
        class="igt-sentence"
        data-sentence-id=${sentence.id}
        role="group"
        aria-label=${`Sentence ${index + 1}`}
      >
        <h3 class="igt-sr-only">Sentence ${index + 1}</h3>
        <span class="igt-sentence__num" aria-hidden="true">${index + 1}</span>
        <span class="igt-sentence__cmt"
          >${this._commentBadge('token', sentence.id, `sentence ${index + 1}`)}</span
        >
        ${this._copyControl(sentence, ctx)}
        <div class="igt-grid">
          <div class="igt-tokens">
            ${this._labels(ctx)}
            ${repeat(
              cols,
              (p) => (p.isToken ? p.id : `gap:${p.begin}-${p.end}`),
              (p) => (p.isToken ? this._tokenCol(p, ctx) : this._gapCol(p)),
            )}
          </div>
        </div>
        ${this._sentenceAnnos(sentence, index, ctx)}
      </div>
    `;
  }

  // ---- minimized rows ------------------------------------------------------
  // A row is identified by scope+name (matching the field key convention in
  // igtConfig), so renaming a field retires its old preference rather than
  // silently minimizing an unrelated new one.
  _rowStorageKey() {
    return `plaid_igt_collapsed_rows:${this.doc?.project?.id ?? 'unknown'}`;
  }

  _loadCollapsedRows() {
    try {
      const raw = localStorage.getItem(this._rowStorageKey());
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      // Private mode / blocked storage: minimizing still works for this
      // session, it just will not be remembered.
      return new Set();
    }
  }

  _saveCollapsedRows() {
    try {
      localStorage.setItem(this._rowStorageKey(), JSON.stringify([...this._collapsedRows]));
    } catch {
      /* storage unavailable — keep the in-session state */
    }
  }

  // Every minimizable row, in the order it appears on screen: the grid rows
  // first, then the sentence-scoped fields that sit under the grid. The
  // word-form row is deliberately absent — the word forms ARE the text, and
  // hiding them would leave the columns with nothing to align against.
  _rows(ctx) {
    const rows = [
      ...ctx.orthographies.map((name) => ({ key: `orth:${name}`, name, scope: 'orthography' })),
      ...ctx.wordFields.map((name) => ({ key: `word:${name}`, name, scope: 'word' })),
    ];
    if (ctx.hasMorphemes) {
      rows.push({ key: 'morphform', name: 'Morphemes', scope: 'morpheme' });
      rows.push(
        ...ctx.morphFields.map((name) => ({ key: `morph:${name}`, name, scope: 'morpheme' })),
      );
    }
    rows.push(...ctx.sentFields.map((name) => ({ key: `sent:${name}`, name, scope: 'sentence' })));
    return rows;
  }

  _isCollapsed(key) {
    return this._collapsedRows.has(key);
  }

  // Class suffix shared by a row's label and all of its cells.
  _rowCls(key) {
    return this._isCollapsed(key) ? ' is-row-collapsed' : '';
  }

  _toggleRow(key) {
    if (this._collapsedRows.has(key)) this._collapsedRows.delete(key);
    else this._collapsedRows.add(key);
    this._saveCollapsedRows();
    this._render(true);
  }

  _setAllRows(ctx, collapsed) {
    this._collapsedRows = collapsed ? new Set(this._rows(ctx).map((r) => r.key)) : new Set();
    this._saveCollapsedRows();
    this._render(true);
  }

  _closeRowMenu() {
    if (!this._rowMenu) return;
    this._rowMenu = null;
    this._rowMenuAnchor = null;
    this._render(true);
  }

  // Open the row menu under the label that was clicked (grid label or sentence
  // label — both are openers). Clicking the SAME label again closes; clicking a
  // different one moves the menu there rather than making you close and reopen.
  _openRowMenuFrom(e) {
    e.stopPropagation();
    const anchor = e.currentTarget;
    if (this._rowMenu && this._rowMenuAnchor === anchor) {
      this._rowMenu = null;
      this._rowMenuAnchor = null;
    } else {
      this._rowMenu = this._computeRowMenuPos(anchor);
      this._rowMenuAnchor = anchor;
    }
    this._render(true);
  }

  // Keep the menu glued to its label while the page or grid scrolls, the same
  // way _repositionPopover does for the vocab popover. Patches the fixed coords
  // directly rather than re-rendering per frame; closes only if the label left
  // the DOM (a reload re-derived the grid, or the page changed).
  _repositionRowMenu() {
    if (!this._rowMenu) return;
    const anchor = this._rowMenuAnchor;
    if (!anchor || !anchor.isConnected) {
      this._closeRowMenu();
      return;
    }
    const pos = this._computeRowMenuPos(anchor);
    if (!pos) return;
    this._rowMenu = pos;
    const el = this.container.querySelector('.igt-rowmenu');
    if (el) {
      el.style.left = `${pos.left}px`;
      el.style.top = `${pos.top}px`;
    }
  }

  // Viewport coords under the clicked label, clamped into view. `position:
  // fixed` is not a nicety here: .igt-grid sets overflow-x:auto (which forces
  // overflow-y to a clipping value), so an absolutely-positioned menu inside
  // the label column gets cut off at the bottom of the sentence band. Same
  // reason and same approach as _computePopoverPos.
  _computeRowMenuPos(anchorEl) {
    const r = anchorEl?.getBoundingClientRect?.();
    if (!r) return null;
    const W = 232;
    const Hest = Math.min(
      360,
      92 +
        this._rows(
          this._lastCtx ?? { orthographies: [], wordFields: [], morphFields: [], sentFields: [] },
        ).length *
          26,
    );
    const pad = 8;
    let left = Math.max(pad, Math.min(r.left, window.innerWidth - W - pad));
    let top = r.bottom + 4;
    if (top + Hest > window.innerHeight) {
      const above = r.top - Hest - 4;
      top = above > pad ? above : Math.max(pad, window.innerHeight - Hest - pad);
    }
    return { left, top };
  }

  _rowMenuPanel(ctx) {
    const rows = this._rows(ctx);
    const anyCollapsed = rows.some((r) => this._isCollapsed(r.key));
    const pos = this._rowMenu;
    const posStyle = pos ? `left:${pos.left}px;top:${pos.top}px;` : '';
    return html`
      <div class="igt-rowmenu" style=${posStyle} role="menu" @click=${(e) => e.stopPropagation()}>
        <div class="igt-rowmenu__head">
          <span>Rows</span>
          <button
            type="button"
            class="igt-rowmenu__all"
            @click=${() => this._setAllRows(ctx, !anyCollapsed)}
          >
            ${anyCollapsed ? 'Expand all' : 'Minimize all'}
          </button>
        </div>
        ${rows.map((r) => {
          const collapsed = this._isCollapsed(r.key);
          return html`
            <label class="igt-rowmenu__item" title=${`${r.name} (${r.scope})`}>
              <input
                type="checkbox"
                .checked=${!collapsed}
                @change=${() => this._toggleRow(r.key)}
              />
              <span class="igt-rowmenu__name">${r.name}</span>
              <span class="igt-rowmenu__scope">${r.scope}</span>
            </label>
          `;
        })}
        <div class="igt-rowmenu__hint">minimized rows stay as a thin stripe</div>
      </div>
    `;
  }

  _labels(ctx) {
    // Each label is truncated with an ellipsis (see .igt-row-label__text) so a
    // long field/orthography name can't spill into the token grid; the row's
    // title attr keeps the full name available on hover.
    // Clicking any label opens the row menu (minimize / expand). The whole label
    // is the hit target rather than a separate affordance: the column is narrow,
    // and a 6px minimized row has no room for an icon.
    const openMenu = (e) => this._openRowMenuFrom(e);
    const lbl = (cls, name, scope, key) => {
      const collapsed = this._isCollapsed(key);
      return html` <div
        class="igt-row-label ${cls}${this._rowCls(key)}"
        data-row=${key}
        title=${collapsed ? `${name} (${scope}) — minimized` : `${name} (${scope})`}
        role="button"
        tabindex="0"
        aria-expanded=${collapsed ? 'false' : 'true'}
        @click=${openMenu}
        @keydown=${(e) => {
          if (e.key === 'Enter' || e.key === ' ') openMenu(e);
        }}
      >
        <span class="igt-row-label__text">${name}</span>
      </div>`;
    };
    return html`
      <div class="igt-labels">
        <div class="igt-row-label igt-row-label--spacer"></div>
        ${ctx.orthographies.map((n) => lbl('igt-row-label--orth', n, 'orthography', `orth:${n}`))}
        ${ctx.wordFields.map((n) => lbl('igt-row-label--word', n, 'word', `word:${n}`))}
        ${ctx.hasMorphemes
          ? lbl(
              'igt-row-label--morph igt-row-label--morphform',
              'Morphemes',
              'morpheme',
              'morphform',
            )
          : nothing}
        ${ctx.hasMorphemes
          ? ctx.morphFields.map((n) => lbl('igt-row-label--morph', n, 'morpheme', `morph:${n}`))
          : nothing}
      </div>
    `;
  }

  // Cross-browser content sizing fallback (for browsers without CSS
  // field-sizing): the input's `size` attr tracks its value's code-point length.
  _fieldSize(v) {
    return Math.max(5, [...(v ?? '')].length + 1);
  }

  _tokenCol(token, ctx) {
    // Ignored tokens (punctuation, per the project's ignored-tokens config) are
    // real word tokens but carry no annotation — no orthographies, no gloss, no
    // lexicon link, and no morpheme is healed onto them (see igtReconcile). They
    // render like a gap: in the text, but plainly not glossed.
    if (isTokenIgnored(token.content, ctx.ignoredCfg)) {
      return this._inertCol(token.content, `${token.content}: excluded from annotation`);
    }
    // Machine-made word tokens (a tokenizer service stamps prov on token
    // metadata) show the same violet/dashed treatment on the form band;
    // Ctrl+Enter on the word confirms the token along with its analysis.
    const wp = provDisplay(token.metadata);
    const wpTitle =
      wp === PROV_STATES.MACHINE
        ? `${token.content}: machine-tokenized, unverified. Ctrl+Enter accepts the whole word`
        : wp === PROV_STATES.VERIFIED
          ? `${token.content}: machine-tokenized, confirmed`
          : token.content;
    return html`
      <div class="igt-token-col" data-word-col=${token.id}>
        <div class="igt-token-form ${provClass('igt-token-form', wp)}" title=${wpTitle}>
          ${this._vocabFace(token.content, {
            id: token.id,
            vocabItem: token.vocabItem,
            formText: token.content,
            kind: 'word',
          })}
          ${this._commentBadge('token', token.id, token.content)}
        </div>
        ${ctx.orthographies.map(
          (name) => html`
            <div class="igt-cell${this._rowCls(`orth:${name}`)}" data-row=${`orth:${name}`}>
              ${this._field({
                key: `or:${token.id}:${name}`,
                value: token.orthographies?.[name] ?? '',
                apply: (v) => this.doc.updateOrthography(token.id, name, v),
                ariaLabel: `${name} for ${token.content}`,
              })}
            </div>
          `,
        )}
        ${ctx.wordFields.map(
          (name) =>
            html`<div class="igt-cell${this._rowCls(`word:${name}`)}" data-row=${`word:${name}`}>
              ${token.annotations?.[name]?.id
                ? this._commentBadge(
                    'span',
                    token.annotations[name].id,
                    `${name} of ${token.content}`,
                  )
                : nothing}
              ${this._field({
                key: `wa:${token.id}:${name}`,
                value: token.annotations?.[name]?.value ?? '',
                apply: (v, meta) => this.doc.updateTokenSpan(token.id, name, v, meta),
                ariaLabel: `${name} for ${token.content}`,
                guess:
                  ctx.guess?.guessFor(
                    'word',
                    this._precedentForm(token.content, KINDS.WORD),
                    name,
                    {
                      vocabItem: token.vocabItem,
                    },
                  ) ?? null,
                alternatives: () =>
                  listAlternatives({
                    precedent: this._precedentTally(),
                    kind: KINDS.WORD,
                    form: this._precedentForm(token.content, KINDS.WORD),
                    field: name,
                    vocabItem: token.vocabItem,
                    span: token.annotations?.[name],
                  }),
                prov: provDisplay(token.annotations?.[name]?.metadata),
                confirmWord: token.id,
              })}
            </div>`,
        )}
        ${ctx.hasMorphemes ? this._morphemes(token, ctx) : nothing}
      </div>
    `;
  }

  // A slim, non-editable column for baseline text that carries no annotation:
  // both gaps (text no token covers) and ignored word tokens (e.g. punctuation)
  // render this way — the text in the header, nothing editable below, a
  // full-height column rule so it reads as a real grid column. Only the top
  // (word-form) band is occupied, so the gray header strip stays continuous.
  _inertCol(content, title) {
    const text = (content || '').trim();
    return html`
      <div class="igt-gap-col">
        <div class="igt-gap-form" title=${title}>${text}</div>
      </div>
    `;
  }

  // A run of baseline text that no word token covers — punctuation, stray
  // characters, anything between or around tokens.
  _gapCol(piece) {
    const text = (piece.content || '').trim();
    return this._inertCol(text, `${text}: not part of any word`);
  }

  _morphemes(token, ctx) {
    const morphemes = token.morphemes || [];
    // The affix joint ("-", or "=" for clitics) belongs to the BOUNDARY, not to
    // either morpheme — it renders between the columns, straddling the gap.
    return html`
      <div class="igt-morphemes">
        ${repeat(
          morphemes,
          (m) => m.id,
          (m, i) => {
            const joiner = i > 0 ? morphemeJoiner(morphemes[i - 1]?.morphType, m.morphType) : null;
            return html`
              ${joiner
                ? html`<span class="igt-morph-joiner" aria-hidden="true">${joiner}</span>`
                : nothing}
              ${this._morphCol(m, token, morphemes, ctx)}
            `;
          },
        )}
      </div>
    `;
  }

  _morphCol(morph, word, siblings, ctx) {
    const value = morphFormOf(morph);
    const filled = value !== '';
    // Chips linked to a stem/root lexicon entry keep the lavender accent —
    // a coverage cue for lexical identification; everything else stays quiet.
    const stem = !!morph.vocabItem && isStemType(morph.morphType);
    // Machine-made segmentation (copied analyses) marks the morpheme TOKEN's
    // metadata; the form cell carries the unverified/verified styling.
    const prov = provDisplay(morph.metadata);
    return html`
      <div class="igt-morph-col">
        <div
          class="igt-morph-form ${stem ? 'igt-morph-form--stem' : ''}${this._rowCls('morphform')}"
          data-row="morphform"
        >
          ${this._vocabFace(
            html`<input
              class="igt-field igt-morph-field ${filled
                ? 'igt-field--filled'
                : 'igt-field--empty'} ${provClass('igt-field', prov)}"
              data-cell-key=${`mf:${morph.id}`}
              data-word=${word.id}
              data-prec=${morph.precedence ?? 1}
              data-confirm-word=${word.id}
              aria-label=${`Morpheme form${value ? ` ${value}` : ''}`}
              title=${prov ? provTitle(value, prov) : filled ? value : nothing}
              size=${this._fieldSize(value)}
              ?disabled=${this.readOnly}
              ${uncontrolledValue(value)}
              @focus=${this._onMorphFormFocus}
              @input=${this._onFieldInput}
              @keydown=${this._morphFormKeydown(morph, word, siblings)}
              @paste=${this._onMorphPaste(morph, word)}
              @blur=${(e) => this._commitMorphForm(e, morph.id)}
            />`,
            { id: morph.id, vocabItem: morph.vocabItem, formText: value, kind: 'morpheme' },
          )}
          ${this._commentBadge('token', morph.id, value || 'morpheme')}
        </div>
        ${ctx.morphFields.map(
          (name) => html`
            <div class="igt-morph-cell${this._rowCls(`morph:${name}`)}" data-row=${`morph:${name}`}>
              ${morph.annotations?.[name]?.id
                ? this._commentBadge(
                    'span',
                    morph.annotations[name].id,
                    `${name} of ${value || 'morpheme'}`,
                  )
                : nothing}
              ${this._field({
                key: `ma:${morph.id}:${name}`,
                value: morph.annotations?.[name]?.value ?? '',
                apply: (v, meta) => this.doc.updateMorphemeSpan(morph.id, name, v, meta),
                extraClass: 'igt-morph-field',
                ariaLabel: `${name} for morpheme${value ? ` ${value}` : ''}`,
                guess:
                  ctx.guess?.guessFor('morpheme', value, name, { vocabItem: morph.vocabItem }) ??
                  null,
                alternatives: () =>
                  listAlternatives({
                    precedent: this._precedentTally(),
                    kind: KINDS.MORPHEME,
                    form: value,
                    field: name,
                    vocabItem: morph.vocabItem,
                    span: morph.annotations?.[name],
                  }),
                prov: provDisplay(morph.annotations?.[name]?.metadata),
                confirmWord: word.id,
              })}
            </div>
          `,
        )}
      </div>
    `;
  }

  // Sentence-scoped fields, under the grid. They minimize from the same row menu
  // as the grid rows, and their label is the same kind of opener. Unlike a grid
  // row, a minimized one drops its field entirely rather than keeping an empty
  // box: nothing down here has to stay in lockstep with the token columns.
  _sentenceAnnos(sentence, index, ctx) {
    if (!ctx.sentFields.length) return nothing;
    return html`
      <div class="igt-sentence-annos">
        ${ctx.sentFields.map((name) => {
          const key = `sent:${name}`;
          const collapsed = this._isCollapsed(key);
          return html`
            <div class="igt-sentence-anno${this._rowCls(key)}">
              <span
                class="igt-sentence-anno__label"
                data-row=${key}
                title=${collapsed ? `${name} (sentence) — minimized` : `${name} (sentence)`}
                role="button"
                tabindex="0"
                aria-expanded=${collapsed ? 'false' : 'true'}
                @click=${(e) => this._openRowMenuFrom(e)}
                @keydown=${(e) => {
                  if (e.key === 'Enter' || e.key === ' ') this._openRowMenuFrom(e);
                }}
              >
                <span class="igt-sentence-anno__text">${name}</span>
              </span>
              ${collapsed
                ? nothing
                : html`
                    ${sentence.annotations?.[name]?.id
                      ? this._commentBadge(
                          'span',
                          sentence.annotations[name].id,
                          `${name} of sentence ${index + 1}`,
                        )
                      : nothing}
                    ${this._field({
                      key: `sa:${sentence.id}:${name}`,
                      value: sentence.annotations?.[name]?.value ?? '',
                      apply: (v) => this.doc.updateSentenceSpan(sentence.id, name, v),
                      sentence: true,
                      ariaLabel: `${name} for sentence ${index + 1}`,
                      prov: provDisplay(sentence.annotations?.[name]?.metadata),
                      confirmSentence: sentence.id,
                      fieldName: name,
                    })}
                  `}
            </div>
          `;
        })}
      </div>
    `;
  }

  // Display a baseline form (word/morpheme) with a vocab-link affordance: the
  // linked item's form as a chip (click to manage), or a "link" control when
  // nothing is linked (hidden at rest, revealed on column hover / keyboard
  // focus — see .igt-vocab__link in the CSS). Both are real <button>s so
  // they're keyboard-focusable and operable (Enter/Space). `face` may be a
  // string or an input template. opts: { id, vocabItem, formText, kind }
  _vocabFace(face, opts) {
    const { id, vocabItem, formText, kind } = opts;
    const hasVocabs = Object.keys(this.doc.vocabularies || {}).length > 0;
    // Variant matters, not just the id: a comment popover on a WORD stores
    // that word's token id too, so matching on the id alone opened the lexicon
    // menu underneath the comment thread.
    const open = this._popover?.variant === 'vocab' && this._popover.tokenId === id;
    const canLink = hasVocabs && !this.readOnly;
    const openerClick = (e) => {
      e.stopPropagation();
      open ? this._closePopover() : this._openPopover(id, kind, e.currentTarget);
    };
    let opener = nothing;
    if (vocabItem) {
      // Three-way provenance: human links plain, machine-unverified violet,
      // machine-verified quietly marked. derive.js always sets vocabItem.prov.
      const state = vocabItem.prov;
      const stateClass = provClass('igt-vocab__hint', state === PROV_STATES.HUMAN ? null : state);
      const title =
        state === PROV_STATES.MACHINE
          ? `Auto-linked to "${vocabItem.form}": open to confirm or change`
          : state === PROV_STATES.VERIFIED
            ? `Linked to "${vocabItem.form}": auto-linked, confirmed${canLink ? ' · manage' : ''}`
            : `Linked to "${vocabItem.form}"${canLink ? ' · manage' : ''}`;
      const sub = this._homonymSub(vocabItem);
      opener = html`<button
        type="button"
        class="igt-vocab__opener igt-vocab__hint ${stateClass}"
        data-vocab-opener=${id}
        data-pop-opener=${`vocab:${id}`}
        ?disabled=${!canLink}
        title=${title}
        @click=${openerClick}
      >
        ${vocabItem.form}${sub != null ? html`<sub class="igt-vocab__sub">${sub}</sub>` : nothing}
      </button>`;
    } else if (canLink) {
      opener = html`<button
        type="button"
        class="igt-vocab__opener igt-vocab__link"
        data-vocab-opener=${id}
        data-pop-opener=${`vocab:${id}`}
        title="Link to a lexicon entry"
        @click=${openerClick}
      >
        link
      </button>`;
    }
    return html`
      <span class="igt-vocab">
        ${face} ${opener} ${open ? this._vocabPopover(id, formText, vocabItem, kind) : nothing}
      </span>
    `;
  }

  // Homonym subscripts (form₂) for vocab items that share a form within a
  // vocab — FLEx-style sense numbering by creation order. Cached per
  // doc.dataVersion so we regroup only when the data actually changes.
  // Browsers fire mousemove when content re-flows UNDER a stationary pointer
  // (a popover re-render, a row growing). Only a real pointer movement should
  // move the keyboard highlight, or Enter can land on a row the user never
  // hovered (TEST_PLAN finding 17).
  _pointerMoved(e) {
    const last = this._lastPointer;
    this._lastPointer = { x: e.clientX, y: e.clientY };
    return !last || last.x !== e.clientX || last.y !== e.clientY;
  }

  _homonymIndexFor(vocabId) {
    const dv = this.doc?.dataVersion;
    if (this._homonymCacheKey !== dv) {
      this._homonymCacheKey = dv;
      this._homonymCache = new Map();
    }
    if (!this._homonymCache.has(vocabId)) {
      const items = (this.doc?.vocabularies || {})[vocabId]?.items || [];
      this._homonymCache.set(vocabId, buildHomonymIndex(items));
    }
    return this._homonymCache.get(vocabId);
  }

  // Precedent (domain/precedent.js) behind the popover's ranking and the
  // gloss guesses: the project-wide link and annotation-value tallies,
  // fetched once per document with THIS document left out, plus this
  // document's own links and values folded live from the derived sentences,
  // so a decision made a moment ago already counts and nothing is counted
  // twice. Until the queries answer, everything ranks on the document alone;
  // the island re-renders when they land. A failed fetch keeps it that way
  // (popover and guesses still work).
  _ensurePrecedent() {
    const doc = this.doc;
    const vocabIds = Object.keys(doc?.vocabularies || {}).sort();
    const valueQueries = doc?.layerInfo
      ? valuePrecedentQueries(doc.layerInfo, { excludeDocId: doc.id })
      : [];
    const key = `${doc?.id}|${vocabIds.join(',')}|${valueQueries
      .map((q) => q.query.where[0][2].layer)
      .join(',')}`;
    if (this._precedent?.key === key) return;
    const state = { key, results: null };
    this._precedent = state;
    if (!doc?.client || (!vocabIds.length && !valueQueries.length)) return;
    const client = doc.client;
    Promise.all([
      Promise.all(
        linkPrecedentQueries(vocabIds, { excludeDocId: doc.id }).map((q) => client.query(q)),
      ),
      Promise.all(
        valueQueries.map(({ kind, field, query }) =>
          client.query(query).then((results) => ({ kind, field, results })),
        ),
      ),
    ])
      .then(([links, values]) => {
        state.results = { links, values };
      })
      .catch((err) => {
        console.warn('Project precedent unavailable; using this document only:', err);
        state.results = NO_PRECEDENT;
      })
      .finally(() => {
        if (this._precedent === state) this._render(true);
      });
  }

  _precedentTally() {
    const results = this._precedent?.results || NO_PRECEDENT;
    const dv = this.doc?.dataVersion;
    const memo = this._precedentMemo;
    if (!memo || memo.results !== results || memo.dv !== dv) {
      const info = this.doc?.layerInfo;
      const tally = foldProject(createTally(), results, this._ignoredCfg);
      foldDocument(tally, this.doc?.sentences, {
        wordFields: (info?.spanLayers?.word || []).map((l) => l.name),
        morphFields: (info?.spanLayers?.morpheme || []).map((l) => l.name),
        ignoredCfg: this._ignoredCfg,
      });
      this._precedentMemo = { results, dv, tally };
    }
    return this._precedentMemo.tally;
  }

  // The tally key for a word/morpheme: a word loses edge punctuation by the
  // ignore rule (as the auto-linker and "+ Create" do), a morpheme form is
  // taken verbatim.
  _precedentForm(formText, kind) {
    return precedentForm(formText, kind, this._ignoredCfg);
  }

  _homonymSub(vocabItem) {
    if (!vocabItem?.vocabId) return null;
    const idx = this._homonymIndexFor(vocabItem.vocabId).get(vocabItem.id);
    return idx != null ? idx : null;
  }

  // The secondary line for a popover item row: values of the vocab's
  // inline-flagged custom fields (vocab config igt.fields {name: {inline}}),
  // falling back to the item's first non-empty metadata value when no field
  // is flagged — so glosses/definitions show out of the box and homophonous
  // forms are distinguishable.
  _vocabItemDetail(item, vocab) {
    const meta = item.metadata || {};
    const fields = readVocabFields(vocab?.config) || {};
    const inlineNames = Object.keys(fields).filter((n) => fields[n]?.inline);
    const names = inlineNames.length ? inlineNames : Object.keys(meta);
    const vals = names
      .map((n) => meta[n])
      .filter((v) => v != null && String(v).trim() !== '')
      .map(String);
    return inlineNames.length ? vals.join(' · ') : (vals[0] ?? '');
  }

  _vocabPopover(tokenId, formText, currentItem, kind) {
    const vocabs = Object.values(this.doc.vocabularies || {});
    // The popover is scoped to ONE vocabulary at a time, chosen by the thin
    // selector at the bottom. Default to the linked item's vocab (so an existing
    // link is visible), else the first. The list, create, and manage row all
    // follow the active vocab.
    const activeVocab =
      vocabs.find((v) => v.id === this._popoverVocabId) ||
      vocabs.find((v) => v.id === currentItem?.vocabId) ||
      vocabs[0] ||
      null;
    this._popoverVocabId = activeVocab?.id ?? null;

    const search = this._popoverSearch || '';
    const homIdx = activeVocab ? this._homonymIndexFor(activeVocab.id) : null;
    // Ranked by vocabRank.js: what this form was linked to before comes
    // first, then form-match tiers; a typed search ranks against the typed
    // text alone.
    const precForm = this._precedentForm(formText, kind);
    const items = rankVocabItems(
      (activeVocab?.items || []).map((it) => ({
        ...it,
        _detail: this._vocabItemDetail(it, activeVocab),
        _sub: homIdx ? homIdx.get(it.id) : null,
      })),
      {
        form: formText || '',
        search,
        precedent: precedentCounts(this._precedentTally(), kind, precForm, SLOT_LINK),
      },
    );
    if (currentItem) {
      const i = items.findIndex((it) => it.id === currentItem.id);
      if (i > 0) {
        const [x] = items.splice(i, 1);
        items.unshift(x);
      }
    }
    const limited = items.slice(0, 30);
    const truncated = items.length - limited.length;
    // The form a new entry would get: the word/morpheme's surface with edge
    // punctuation trimmed by the project's own ignored-tokens rule
    // (`derechos.` → `derechos`; user decision 2026-08-26).
    const createForm = trimIgnoredEdges(formText || '', this._ignoredCfg);
    // A single "+ Create" row, into the active vocab, when there's a form AND
    // this user may add entries to it. Item creation needs vocab-maintainer
    // rights while linking needs only project-writer + vocab-reader, so a
    // writer who can link may still not create — hide the row instead of
    // letting it 403.
    const canCreate = !!(createForm && activeVocab && this.canWriteVocab(activeVocab));
    // While the row is being edited the entry's form is whatever is typed.
    const editingCreate = canCreate && this._popoverCreateEdit != null;
    const effectiveForm = editingCreate ? this._popoverCreateEdit.trim() : createForm;
    // If the form already exists in the active vocab, the new item would be a
    // homonym — preview the subscript it would get (existing count + 1) and
    // say so, since a duplicate is usually a mis-click on the existing entry.
    const newFormDupes =
      canCreate && effectiveForm
        ? (activeVocab.items || []).filter((it) => it.form === effectiveForm).length
        : 0;
    const newFormSub = newFormDupes >= 1 ? newFormDupes + 1 : null;
    // Rows the keyboard can land on: every item plus the create row.
    const total = limited.length + (canCreate ? 1 : 0);
    const activeIdx = Math.min(this._popoverActiveIndex ?? 0, Math.max(0, total - 1));
    const pos = this._popoverPos;
    const posStyle = pos
      ? `position:fixed;left:${pos.left}px;top:${pos.top}px;transform:none;margin-top:0;`
      : '';

    // For a machine-unverified link, selecting the linked row CONFIRMS it (the
    // human gesture that flips provConfirmed); for a human link it unlinks
    // (toggle), as before. The explicit "unlink" mini-action is always available.
    const inferredCurrent = currentItem?.prov === PROV_STATES.MACHINE;
    const selectActive = (immediate = false) => {
      if (activeIdx < limited.length) {
        const it = limited[activeIdx];
        const linked = currentItem && it.id === currentItem.id;
        if (linked && inferredCurrent) this._confirmLink(tokenId, true);
        else this._toggleVocab(tokenId, it, linked, true);
      } else if (canCreate) {
        // Enter on the create row opens the inline editor (edit the form
        // first); Ctrl/Cmd+Enter creates as-is, like a double-click.
        if (immediate) this._createVocab(tokenId, activeVocab.id, createForm, true);
        else this._openCreateEdit(createForm);
      }
    };
    // Inline create editor keys: Enter creates (non-empty), Escape goes back
    // to the search box, Tab stays trapped in the dialog.
    const onCreateEditKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = (e.target.value || '').trim();
        if (v) this._createVocab(tokenId, activeVocab.id, v, true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this._cancelCreateEdit();
      } else if (e.key === 'Tab') {
        e.preventDefault();
      }
    };
    // Click on the create row: a single click opens the editor, a double
    // click (second click within 250ms) creates immediately. While editing,
    // a click on the row acts as the "create" button for the typed form.
    const onCreateClick = (e) => {
      e.stopPropagation();
      if (editingCreate) {
        const v = effectiveForm;
        if (v) this._createVocab(tokenId, activeVocab.id, v);
        return;
      }
      if (this._createClickTimer) {
        clearTimeout(this._createClickTimer);
        this._createClickTimer = null;
        this._createVocab(tokenId, activeVocab.id, createForm);
        return;
      }
      this._createClickTimer = setTimeout(() => {
        this._createClickTimer = null;
        if (this._popover) this._openCreateEdit(createForm);
      }, 250);
    };
    const onSearchKey = (e) => {
      // Popover keys must not bubble to the container's review-sweep handler:
      // Enter here selects a row, which moves focus onto a chip, and the same
      // keydown would then be read as "Enter on a focused chip" (a stray
      // confirm + focus hop to the next suggestion).
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this._closePopover(true);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this._movePopoverActive(1, total);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this._movePopoverActive(-1, total);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        selectActive(e.ctrlKey || e.metaKey);
      } else if (e.key === 'Tab') {
        e.preventDefault();
      } // trap focus in the search box
    };
    const selectVocab = (id) => {
      this._popoverVocabId = id;
      this._popoverActiveIndex = 0;
      this._render(true);
    };

    return html`
      <div
        class="igt-vocab-pop"
        data-igt-pop
        style=${posStyle}
        role="dialog"
        aria-label="Link to lexicon"
        @click=${(e) => e.stopPropagation()}
      >
        <input
          class="igt-vocab-pop__search"
          data-pop-autofocus
          placeholder="Search lexicon…"
          aria-label="Search lexicon"
          .value=${live(this._popoverSearch || '')}
          @input=${(e) => {
            this._popoverSearch = e.target.value;
            this._popoverActiveIndex = 0;
            this._render(true);
          }}
          @keydown=${onSearchKey}
        />
        <div class="igt-vocab-pop__list">
          ${limited.length
            ? limited.map((it, i) => {
                const linked = currentItem && it.id === currentItem.id;
                const confirmable = linked && inferredCurrent;
                return html`<button
                  type="button"
                  class="igt-vocab-pop__item ${linked ? 'is-linked' : ''} ${i === activeIdx
                    ? 'is-active'
                    : ''}"
                  @mousemove=${(e) => {
                    if (!this._pointerMoved(e)) return;
                    if (this._popoverActiveIndex !== i) {
                      this._popoverActiveIndex = i;
                      this._render(true);
                    }
                  }}
                  @click=${(e) => {
                    e.stopPropagation();
                    if (confirmable) this._confirmLink(tokenId);
                    else this._toggleVocab(tokenId, it, linked);
                  }}
                >
                  <span class="igt-vocab-pop__main">
                    ${linked
                      ? html`<a
                          class="igt-vocab-pop__form igt-vocab-pop__goto"
                          href=${`#/vocabularies/${activeVocab.id}?item=${it.id}`}
                          title="Open this entry in the lexicon"
                          @click=${(e) => e.stopPropagation()}
                          >${it.form}${it._sub != null
                            ? html`<sub class="igt-vocab-pop__sub">${it._sub}</sub>`
                            : nothing}</a
                        >`
                      : html`<span class="igt-vocab-pop__form"
                          >${it.form}${it._sub != null
                            ? html`<sub class="igt-vocab-pop__sub">${it._sub}</sub>`
                            : nothing}</span
                        >`}
                    ${it._prec
                      ? html`<span
                          class="igt-vocab-pop__prec"
                          title=${`“${precForm}” was linked to this entry ${it._prec} time${
                            it._prec === 1 ? '' : 's'
                          } in this project`}
                          >×${it._prec}</span
                        >`
                      : nothing}
                    ${confirmable ? html`<span class="igt-vocab-pop__ok">confirm</span>` : nothing}
                    ${linked
                      ? html`<span
                          class="igt-vocab-pop__x"
                          role="button"
                          tabindex="-1"
                          @click=${(e) => {
                            e.stopPropagation();
                            this._toggleVocab(tokenId, it, true);
                          }}
                          >unlink</span
                        >`
                      : nothing}
                  </span>
                  ${it._detail
                    ? html`<span class="igt-vocab-pop__detail">${it._detail}</span>`
                    : nothing}
                </button>`;
              })
            : html`<div class="igt-vocab-pop__empty">No matches</div>`}
          ${truncated > 0
            ? html`<div class="igt-vocab-pop__more">+ ${truncated} more. Type to narrow</div>`
            : nothing}
        </div>
        ${canCreate
          ? html`<button
              type="button"
              class="igt-vocab-pop__create ${activeIdx === limited.length ? 'is-active' : ''}"
              @mousemove=${(e) => {
                if (!this._pointerMoved(e)) return;
                const idx = limited.length;
                if (this._popoverActiveIndex !== idx) {
                  this._popoverActiveIndex = idx;
                  this._render(true);
                }
              }}
              title=${editingCreate
                ? 'Enter creates the entry as typed · Esc cancels'
                : 'Click to edit the form before creating · double-click creates as is'}
              @click=${onCreateClick}
            >
              ${editingCreate
                ? html`+ Create
                    <input
                      class="igt-vocab-pop__create-input"
                      aria-label="New entry form"
                      .value=${live(this._popoverCreateEdit)}
                      @click=${(e) => e.stopPropagation()}
                      @input=${(e) => {
                        this._popoverCreateEdit = e.target.value;
                        this._render(true);
                      }}
                      @keydown=${onCreateEditKey}
                    />${newFormSub != null
                      ? html`<sub class="igt-vocab-pop__sub">${newFormSub}</sub>`
                      : nothing}`
                : html`+ Create
                  "${createForm}${newFormSub != null
                    ? html`<sub class="igt-vocab-pop__sub">${newFormSub}</sub>`
                    : nothing}"`}
              ${newFormSub != null
                ? html`<span class="igt-vocab-pop__note"
                    >“${effectiveForm}” already exists. This adds a separate sense</span
                  >`
                : nothing}
            </button>`
          : nothing}
        ${kind === 'morpheme' ? this._morphTypeRow(tokenId, currentItem) : nothing}
        ${vocabs.length
          ? html`<div class="igt-vocab-pop__vocabsel" role="tablist" aria-label="Choose lexicon">
              ${vocabs.map((v) => {
                const isActive = v.id === activeVocab?.id;
                // An inactive chip scopes the popover to that lexicon; the active
                // chip is a link to the full vocab view (new tab). So the first
                // click selects, a second click on the now-active chip opens.
                return isActive
                  ? html`<a
                      class="igt-vocab-pop__vocabtab is-active"
                      role="tab"
                      aria-selected="true"
                      href=${`#/vocabularies/${v.id}`}
                      target="_blank"
                      rel="noopener"
                      title=${`Open “${v.name}” in a new tab`}
                      @click=${(e) => e.stopPropagation()}
                      ><span class="igt-vocab-pop__vtab-name">${v.name}</span
                      ><span class="igt-vocab-pop__vtab-ext">↗</span></a
                    >`
                  : html`<button
                      type="button"
                      class="igt-vocab-pop__vocabtab"
                      role="tab"
                      aria-selected="false"
                      title=${`Switch to “${v.name}”`}
                      @click=${(e) => {
                        e.stopPropagation();
                        selectVocab(v.id);
                      }}
                    >
                      <span class="igt-vocab-pop__vtab-name">${v.name}</span>
                    </button>`;
              })}
            </div>`
          : nothing}
      </div>
    `;
  }

  // Morpheme type editor (popover footer row): metadata.morphType from FLEx's
  // exact inventory, or "—" for untyped. Pure metadata — geometry, precedence,
  // and the form are untouched; the display-only affix joints ("-"/"=") react
  // immediately.
  // A LINKED morpheme's type lives on its lexicon entry (the entry overrides
  // the token's cached type, see derive.js), so the row edits the entry —
  // for vocab maintainers; others see it read-only. Unlinked: the token's own.
  _morphTypeRow(morphemeId, currentItem) {
    const morph = (this.doc.layerInfo.morphemeTokenLayer?.tokens || []).find(
      (m) => m.id === morphemeId,
    );
    const linked = !!currentItem?.vocabId;
    const vocab = linked ? this.doc.vocabularies?.[currentItem.vocabId] : null;
    const fromItem = currentItem?.metadata?.morphType;
    const current = (linked && fromItem ? fromItem : morph?.metadata?.morphType) ?? '';
    const canEditEntry = linked && !!vocab && this.canWriteVocab(vocab);
    const disabled = this.readOnly || (linked && !canEditEntry);
    const title = linked
      ? canEditEntry
        ? 'Type of the linked lexicon entry (applies to every morpheme linked to it)'
        : 'Type comes from the linked lexicon entry; only its maintainers can change it'
      : 'Type of this morpheme';
    return html`
      <label class="igt-vocab-pop__type" title=${title} @click=${(e) => e.stopPropagation()}>
        <span>${linked ? 'Type (entry)' : 'Type'}</span>
        <select
          ?disabled=${disabled}
          aria-label=${linked ? 'Lexicon entry morpheme type' : 'Morpheme type'}
          @change=${(e) => {
            e.stopPropagation();
            const value = e.target.value || null;
            if (linked) this.doc.setVocabItemMorphType(currentItem.vocabId, currentItem.id, value);
            else this.doc.setMorphemeType(morphemeId, value);
          }}
        >
          <option value="" ?selected=${current === ''}>—</option>
          ${FLEX_MORPH_TYPES.map(
            (t) => html`<option value=${t} ?selected=${current === t}>${t}</option>`,
          )}
        </select>
      </label>
    `;
  }
}
