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

import './igt-editor.css';
import { render, html, nothing } from 'lit-html';
import { defaultGuessSource, VOCAB_ENTRY_SOURCE } from '@/domain/glossGuess';
import { tagsetEnforces, validateValue } from '@/domain/tagsets';
import { handleComposeBeforeInput } from '@/lib/composeInput';
import { PRECEDENT_REFRESH_MIN_MS, provClass, uncontrolledValue } from './editor/shared.js';
import { comments } from './editor/comments.js';
import { popover } from './editor/popover.js';
import { linking } from './editor/linking.js';
import { mwe } from './editor/mwe.js';
import { cells } from './editor/cells.js';
import { alternatives } from './editor/alternatives.js';
import { review } from './editor/review.js';
import { morphForm } from './editor/morphForm.js';
import { chrome } from './editor/chrome.js';
import { copy } from './editor/copy.js';
import { assistant } from './editor/assistant.js';
import { rows } from './editor/rows.js';
import { grid } from './editor/grid.js';
import { vocabPopover } from './editor/vocabPopover.js';

export class IgtEditor {
  constructor(
    container,
    doc,
    {
      readOnly = false,
      canAutoAnalyze = false,
      canWriteVocab = null,
      comments = null,
      canComment = false,
      canDeleteAnyComment = false,
      assistantOnline = false,
    } = {},
  ) {
    // Event handlers handed to lit templates, bound so `this` survives.
    for (const m of [
      '_onFieldFocus',
      '_onMorphFormFocus',
      '_onFieldInput',
      '_predictionKeydown',
      '_basicKeydown',
      '_onSentenceInput',
      '_sentenceKeydown',
    ])
      this[m] = this[m].bind(this);
    // The comment store is the SAME instance the Comments tab renders from, so
    // a comment posted in the grid shows up there without a refetch. Null when
    // comments are unavailable (no signed-in user yet), and the badges simply
    // do not render.
    this.comments = comments;
    this.canComment = canComment;
    this.canDeleteAnyComment = canDeleteAnyComment;
    // Whether a sentence offers "Ask". Discovered after mount, so it also has
    // a setter (see editor/assistant.js).
    this.assistantOnline = assistantOnline;
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
    // The alternatives popup renders into its OWN root, not into the grid
    // template. It is position:fixed, so it does not need to be a sibling of
    // the cell — and keeping it out means opening, filtering and closing it
    // re-render one small element instead of every cell in the document.
    this._altsRoot = document.createElement('div');
    document.body.appendChild(this._altsRoot);
    this.doc = doc;
    this.readOnly = readOnly;
    this.canAutoAnalyze = canAutoAnalyze;
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
    // A multi-word expression in the making: the words gathered so far, the
    // one sentence they belong to, and the word the keyboard cursor sits on.
    // null when nothing is being gathered (see _mweKeydown / _toggleMweWord).
    this._mweSel = null; // { sentenceId, tokenIds: Set, cursorId } | null
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
      this._clearMweSelection();
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
    // Project-wide precedent (_ensurePrecedent) is fetched once and then held
    // for the life of this instance, so a decision someone else makes
    // elsewhere in the project while this document stays open otherwise never
    // shows up in gloss guesses or the lexicon popover's ranking. Refetching
    // on every keystroke would be wasteful; refetching when the tab regains
    // focus catches it at the moment a person actually resumes work, which is
    // when staleness would otherwise be noticed.
    this._onVisibility = () => {
      if (document.visibilityState !== 'visible' || this.readOnly) return;
      if (Date.now() - (this._precedentFetchedAt || 0) < PRECEDENT_REFRESH_MIN_MS) return;
      this._ensurePrecedent(true);
    };
    document.addEventListener('visibilitychange', this._onVisibility);
    // Keyboard review of auto-linker suggestions: Ctrl/Cmd+Arrow hops between
    // inferred vocab-link chips; Enter/Backspace confirm/remove the focused one
    // (see _predictionKeydown). Container-level so it works from any cell or chip.
    this.container.addEventListener('keydown', this._predictionKeydown);
    // Anything typed while a confirmation's beat is still running flushes it
    // FIRST, in the capture phase, so focus has already moved by the time the
    // key is handled and the character lands where the reader is looking. This
    // is also what stops a held-down Ctrl+Enter from stacking beats.
    this._flushBeatOnInput = () => this._flushBeat();
    this.container.addEventListener('keydown', this._flushBeatOnInput, true);
    this.container.addEventListener('pointerdown', this._flushBeatOnInput, true);
    // Backslash codes (`\sw` -> ə, `\0/` -> ∅) in every text field of the grid.
    // Delegated: `beforeinput` bubbles, and every text field here holds language
    // data, so there is nothing in the island to opt out. See lib/composeInput.js
    // for why this is not a keydown handler.
    this._onBeforeInput = (e) => {
      const el = e.target;
      const tag = el?.tagName;
      const typed = el?.type;
      if (tag === 'TEXTAREA' || (tag === 'INPUT' && (!typed || typed === 'text'))) {
        handleComposeBeforeInput(e);
      }
    };
    this.container.addEventListener('beforeinput', this._onBeforeInput);
    // Hovering any piece of a multi-word expression's bracket lights the whole
    // bracket, so a member on the next band still reads as part of it.
    this._onMweHover = (e) => {
      const el = e.target?.closest?.('[data-mwe]');
      if (!el) return;
      const hot = e.type === 'mouseover';
      this.container
        .querySelectorAll(`[data-mwe="${el.dataset.mwe}"]`)
        .forEach((n) => n.classList.toggle('is-hot', hot));
    };
    this.container.addEventListener('mouseover', this._onMweHover);
    this.container.addEventListener('mouseout', this._onMweHover);
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
    const page = Math.floor(idx / this.constructor.PAGE_SIZE);
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
      // Land on the hit word itself so a long sentence doesn't leave the user
      // hunting for the word: a search hit goes to its morpheme form cell
      // (what the text matched), a hand-off from the Tokenize tab, which says
      // `level: 'word'`, to the word's own row, since a word is what was
      // pressed over there. Either falls back to any cell of the word.
      if (typeof req.begin === 'number') {
        const sentence = this.doc.sentences[idx];
        const word = (sentence?.tokens || []).find(
          (t) => t.begin <= req.begin && req.begin < t.end,
        );
        const q = (sel) => this.container.querySelector(sel);
        const cell =
          word &&
          (req.level === 'word'
            ? q(`.igt-field[data-cell-key^="wa:${word.id}:"]`) ||
              q(`.igt-field[data-cell-key^="or:${word.id}:"]`) ||
              q(`.igt-morph-field[data-word="${word.id}"]`)
            : q(`.igt-morph-field[data-word="${word.id}"]`) ||
              q(`.igt-field[data-confirm-word="${word.id}"]`));
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

  // Whether this user may run Auto-analyze at all, which is NOT `!readOnly`:
  // the run itself takes the document read-only while it writes.
  setCanAutoAnalyze(can) {
    if (this.canAutoAnalyze === can) return;
    this.canAutoAnalyze = can;
    this._render(true);
  }

  // The Auto-analyze run's live status, pushed in by the React shell: a run
  // outlives its dialog, so the button that opened it is where a linguist who
  // closed the box still sees the work moving.
  setAutoAnalyzeStatus(status) {
    const next = status || null;
    const before = this._autoAnalyzeStatus;
    if (before?.running === next?.running && before?.label === next?.label) return;
    this._autoAnalyzeStatus = next;
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
    this._mweSel = null;
    this._render(true);
  }

  destroy() {
    this._altsRoot?.remove();
    this._altsRoot = null;
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
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.container.removeEventListener('keydown', this._predictionKeydown);
    this.container.removeEventListener('keydown', this._flushBeatOnInput, true);
    this.container.removeEventListener('pointerdown', this._flushBeatOnInput, true);
    // A beat left running past teardown would move focus in a grid that is
    // gone; drop it rather than let it fire.
    if (this._beat) clearTimeout(this._beat.timer);
    this._beat = null;
    this.container.removeEventListener('beforeinput', this._onBeforeInput);
    this.container.removeEventListener('mouseover', this._onMweHover);
    this.container.removeEventListener('mouseout', this._onMweHover);
    if (this._repositionRaf) cancelAnimationFrame(this._repositionRaf);
    clearTimeout(this._savedTimer);
    clearTimeout(this._copiedTimer);
    clearTimeout(this._linkTimer);
    clearTimeout(this._createClickTimer);
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
    // Fresh alternatives memo for this pass (see _alternatives).
    this._altsMemo = new Map();
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
    // written a programmatic value, e.g. on load / reload). All the reads
    // happen between the two rounds of writes, so the page lays out twice
    // rather than once per textarea.
    const areas = [...this.container.querySelectorAll('textarea.igt-field--sentence')];
    for (const el of areas) el.style.height = 'auto';
    const heights = areas.map((el) => Math.min(el.scrollHeight, 200));
    areas.forEach((el, i) => {
      el.style.height = `${heights[i]}px`;
    });
  }

  _restorePendingFocus() {
    const pf = this._pendingFocus;
    this._pendingFocus = null;
    if (!pf) return;
    // If the user already moved focus into another field while the structural op
    // was in flight, don't yank it back to the computed target (review: focus theft).
    // A DISABLED field is not that: the paste-split disables its source cell
    // for the flight, and some browsers leave it as activeElement until
    // something else takes focus.
    const active = document.activeElement;
    if (
      active &&
      active !== this.container &&
      this.container.contains(active) &&
      (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') &&
      !active.disabled
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
    // A multi-word expression's bracket label, found by its first word: the
    // link id changes whenever its words do, the first word rarely does.
    if (pf.mweOf != null) {
      const label = this.container.querySelector(`[data-mwe-first="${pf.mweOf}"]`);
      if (label) label.focus();
      return;
    }
    if (pf.cellKey != null) {
      const cell =
        this.container.querySelector(`[data-cell-key="${pf.cellKey}"]`) ??
        (pf.wordId != null
          ? this.container.querySelector(`.igt-field[data-confirm-word="${pf.wordId}"]`)
          : null);
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

  _field({
    key,
    value,
    apply,
    extraClass = '',
    sentence = false,
    ariaLabel,
    guess = null,
    prov = null,
    provOrigin: origin = null,
    confirmWord = null,
    alternatives = null,
    confirmSentence = null,
    fieldName = null,
    tagset = null,
    badge = null,
  }) {
    const v = value ?? '';
    const filled = v !== '';
    // What is wrong with what is already in the cell. A closed field refuses
    // to commit these (see _commitField); an open one only flags a stray
    // delimiter. Either way the cell says so rather than looking fine.
    const violations = tagset ? validateValue(v, tagset) : [];
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
      // Off here too. A free translation is the one field in the grid that is
      // real prose, but a red wavy underline has to mean exactly one thing in
      // this app — an off-tagset value — and fieldwork translations are full of
      // idiomatic renderings and notation a dictionary would reject anyway.
      // A sentence-scoped field can carry a tagset too (a Genre or Speech-act
      // field is as controllable as a POS). Same picker, same flagging: only
      // the control differs, because a Translation still has to wrap.
      return html`<textarea
        class="igt-field igt-field--sentence ${filled
          ? 'igt-field--filled'
          : 'igt-field--empty'} ${violations.length ? 'igt-field--invalid' : ''} ${provClass(
          'igt-field',
          ps,
        )} ${extraClass}"
        data-cell-key=${key}
        data-has-tagset=${tagset ? '1' : nothing}
        data-tagset-delims=${tagset?.delimiters || nothing}
        data-tagset-enforces=${tagsetEnforces(tagset) ? '1' : nothing}
        data-confirm-sentence=${confirmSentence ?? nothing}
        data-field-name=${fieldName ?? nothing}
        aria-label=${ariaLabel ?? nothing}
        title=${violations.length
          ? this._violationText(violations, tagset)
          : ps
            ? `${this._cellTitle(v, ps, origin)}. Ctrl+Enter confirms it as is`
            : nothing}
        rows="1"
        spellcheck="false"
        ?disabled=${this.readOnly}
        .igtAlts=${alternatives || null}
        .igtTagset=${tagset}
        ${uncontrolledValue(v)}
        @focus=${this._onFieldFocus}
        @input=${this._onSentenceInput}
        @keydown=${this._sentenceKeydown}
        @blur=${(e) => this._commitField(e, apply, tagset)}
      ></textarea>`;
    }
    const p = filled ? prov : null;
    // Alternatives (Alt+↓): computed per render so the list and the caret
    // affordance track the data; the thunk rides on the element for _openAlts.
    // The caret affordance, and only that: the popup itself renders elsewhere
    // (see _renderAlts), so nothing here needs the list.
    //
    // A governed cell skips the count entirely. The caret advertises "Alt+Down
    // has more" and only shows on focus, which is the exact moment a governed
    // cell has already opened its list — so it would collide with the text to
    // say nothing. Skipping it also spares the computation on every such cell
    // of every render.
    const nAlts = !tagset && !this.readOnly && alternatives ? alternatives().length : 0;
    const basis = g ? this._guessBasis(g) : null;
    const baseTitle = g
      ? `Guess: ${g.value}${basis ? `, ${basis}` : ''}. Enter accepts it, Ctrl+Enter accepts the whole word, typing replaces`
      : p
        ? this._cellTitle(v, p, origin)
        : filled
          ? v
          : (ariaLabel ?? null);
    const title = violations.length
      ? this._violationText(violations, tagset)
      : nAlts > 1
        ? `${baseTitle ? `${baseTitle}. ` : ''}Alt+↓ lists ${nAlts} values seen for this form`
        : (baseTitle ?? nothing);
    // A suggestion out of the lexicon wears the faint teal of a linked
    // morpheme chip, which already means "lexically identified" here. The wash
    // says where the suggestion came from; how far to trust it is the link
    // chip's job, in the same column.
    const guessCls = g
      ? `igt-field--guess${g.source === VOCAB_ENTRY_SOURCE ? ' igt-field--guess-entry' : ''}`
      : '';
    const input = html`<input
      class="igt-field ${filled ? 'igt-field--filled' : 'igt-field--empty'} ${guessCls} ${nAlts > 1
        ? 'igt-field--alts'
        : ''} ${violations.length ? 'igt-field--invalid' : ''} ${provClass(
        'igt-field',
        p,
      )} ${extraClass}"
      data-cell-key=${key}
      data-has-tagset=${tagset ? '1' : nothing}
      data-tagset-delims=${tagset?.delimiters || nothing}
      data-tagset-enforces=${tagsetEnforces(tagset) ? '1' : nothing}
      data-guess-value=${g ? g.value : nothing}
      data-guess-source=${g ? g.source : nothing}
      data-confirm-word=${confirmWord ?? nothing}
      aria-label=${ariaLabel ?? nothing}
      title=${title}
      .igtAlts=${alternatives || null}
      .igtTagset=${tagset}
      placeholder=${g ? g.value : nothing}
      size=${this._fieldSize(g ? g.value : v)}
      spellcheck="false"
      ?disabled=${this.readOnly}
      ${uncontrolledValue(v)}
      @focus=${this._onFieldFocus}
      @input=${this._onFieldInput}
      @keydown=${this._basicKeydown}
      @blur=${(e) => this._commitField(e, apply, tagset)}
    />`;
    // The comment badge hugs the VALUE, not the cell: a cell is as wide as its
    // column and centers its value, so a badge tangent to the cell's edge
    // lands on the neighbor's corner. The wrapper is the badge's positioning
    // context, exactly as .igt-vocab__face is for a word form.
    //
    // The wrapper is ALWAYS rendered, and only its class says whether it has
    // a box. A cell gains its badge on its first write (the span it now has
    // can be commented on), and a wrapper that appeared only then swapped
    // lit templates and recreated the input under the person's cursor: a
    // pick or an accept left the cell unfocused.
    return html`<span class="igt-cell__face${badge ? ' igt-cell__face--badged' : ''}"
      >${badge ?? nothing}${input}</span
    >`;
  }

  static PAGE_SIZE = 25;
}

// The editor's behavior is spread over the modules in editor/ as mixins on
// the prototype; each is one concern, and `this` inside them is the editor.
Object.assign(
  IgtEditor.prototype,
  comments,
  popover,
  linking,
  mwe,
  cells,
  alternatives,
  review,
  morphForm,
  chrome,
  copy,
  assistant,
  rows,
  grid,
  vocabPopover,
);

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
