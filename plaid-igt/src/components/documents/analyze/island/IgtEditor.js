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
import { provState, PROV_STATES } from '@larc-iu/plaid-client';
import { readOrthographies, readIgnoredTokens, readVocabFields, isTokenIgnored } from '@/domain/igtConfig';
import { docFrequencyGuessSource, confirmedGuessProvenance } from '@/domain/glossGuess';
import { COPY_FORMATS, COPY_FORMAT_STORAGE_KEY, formatSentence } from '@/domain/igtExport';
import { morphemeJoiner, isStemType, FLEX_MORPH_TYPES } from '@/domain/affixMarkers';
import { buildHomonymIndex } from '@/domain/vocabHomonyms';

// Small Levenshtein for ranking lexicon items by similarity to a token's form.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const cur = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      cur[j + 1] = Math.min(cur[j] + 1, prev[j + 1] + 1, prev[j] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

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
  render() { return nothing; }
}
const uncontrolledValue = directive(UncontrolledValueDirective);

const morphFormOf = (m) =>
  m.metadata && Object.prototype.hasOwnProperty.call(m.metadata, 'form')
    ? (m.metadata.form ?? '')
    : (m.content ?? '');

// Display-relevant provenance state of a filled annotation span: 'machine'
// (unverified, violet + dashed) or 'verified' (confirmed, quiet check); null
// for human-made values and empty cells, which render plain.
const spanProv = (span) => {
  if (!span || (span.value ?? '') === '') return null;
  const s = provState(span.metadata);
  return s === PROV_STATES.HUMAN ? null : s;
};

// Same classification for an entity's raw metadata (morpheme tokens).
const metaProv = (metadata) => {
  const s = provState(metadata);
  return s === PROV_STATES.HUMAN ? null : s;
};

const PROV_TITLE = {
  machine: 'machine-suggested, unverified — edit to fix, Ctrl+Enter confirms the whole word',
  verified: 'machine-suggested, confirmed',
};

export class IgtEditor {
  constructor(container, doc, { readOnly = false } = {}) {
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
    // algorithm (e.g. a service-backed one).
    this.guessSourceFactory = docFrequencyGuessSource;
    this._onChange = () => { this._syncStatus(); this._scheduleRender(); };
    this._unsub = doc.subscribe(this._onChange);
    // Per-sentence "Copy as IGT": which sentence's format menu is open, and
    // which sentence just copied (for the "Copied ✓" flash).
    this._copyMenu = null;
    this._copiedFlash = null;
    this._copiedTimer = null;
    // Any click outside an opener/popover/menu (those stopPropagation) closes it.
    this._onDocClick = () => { this._closePopover(); this._closeCopyMenu(); };
    document.addEventListener('click', this._onDocClick);
    // The popover is position:fixed; scrolling the page or the grid, or
    // resizing, would detach it from its column — re-anchor it to its opener
    // (rAF-throttled) instead of closing. Capture phase catches the grid's
    // own scroll. No-op when no popover is open.
    this._onWinChange = () => this._repositionPopover();
    window.addEventListener('scroll', this._onWinChange, true);
    window.addEventListener('resize', this._onWinChange);
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
    try { req = JSON.parse(sessionStorage.getItem('igt:focus-sentence') || 'null'); } catch { /* noop */ }
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
      const el = this.container.querySelector(`.igt-sentence[data-sentence-id="${req.sentenceId}"]`);
      if (!el) return; // throwaway mount already torn down — leave the key for the real one
      sessionStorage.removeItem('igt:focus-sentence');
      el.scrollIntoView({ block: 'center' });
      el.classList.add('igt-sentence--flash');
      setTimeout(() => el.classList.remove('igt-sentence--flash'), 2400);
    });
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
    document.removeEventListener('click', this._onDocClick);
    window.removeEventListener('scroll', this._onWinChange, true);
    window.removeEventListener('resize', this._onWinChange);
    if (this._repositionRaf) cancelAnimationFrame(this._repositionRaf);
    clearTimeout(this._savedTimer);
    clearTimeout(this._copiedTimer);
    render(nothing, this.container);
  }

  // ---- vocab popover ----
  _openPopover(tokenId, kind, anchorEl) {
    this._popover = { tokenId, kind };
    this._popoverSearch = '';
    this._popoverActiveIndex = 0;
    this._popoverVocabId = null; // re-default to the linked item's vocab each open
    this._popoverReturnId = tokenId;
    this._popoverPos = this._computePopoverPos(anchorEl);
    this._render(true);
    // Focus the search box now that it's in the DOM (lit-html `autofocus` is
    // unreliable on nodes inserted by a re-render rather than initial parse).
    const search = this.container.querySelector('.igt-vocab-pop__search');
    if (search) { try { search.focus(); } catch { /* noop */ } }
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
    const active = this.container.querySelector('.igt-vocab-pop .is-active');
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
      const opener = this.container.querySelector(`[data-vocab-opener="${this._popoverReturnId}"]`);
      const pos = opener ? this._computePopoverPos(opener) : null;
      if (!pos) { this._closePopover(); return; }
      this._popoverPos = pos;
      const el = this.container.querySelector('.igt-vocab-pop');
      if (el) { el.style.left = `${pos.left}px`; el.style.top = `${pos.top}px`; }
    });
  }

  // Position the popover (240px wide) below the opener as fixed coords, clamped
  // to the viewport — so edge columns don't overflow and the grid's overflow-x
  // scroll container can't clip it.
  _computePopoverPos(anchorEl) {
    const r = anchorEl?.getBoundingClientRect?.();
    if (!r) return null;
    const W = 240, Hest = 280, pad = 8;
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
    const returnId = this._popoverReturnId;
    this._popover = null;
    this._popoverPos = null;
    this._popoverSearch = '';
    this._popoverActiveIndex = 0;
    this._popoverReturnId = null;
    this._render(true);
    if (returnFocus && returnId != null) {
      const opener = this.container.querySelector(`[data-vocab-opener="${returnId}"]`);
      if (opener) { try { opener.focus(); } catch { /* noop */ } }
    }
  }
  // ---- auto-linking ----
  // The toolbar button opens the React AutoLinkDialog (rendered by the
  // AnalyzeIsland shell), which offers the built-in precedent-or-unique rule
  // plus any registered service advertising the link-vocab task — the same
  // service-selection idiom as the Media/Tokenize tabs. The island only
  // dispatches the open request; results land via the shared doc's reload.
  _openAutoLink() {
    window.dispatchEvent(new CustomEvent('igt:auto-link-open'));
  }

  _confirmLink(tokenId, returnFocus = false) {
    this._closePopover(returnFocus);
    this._run(() => this.doc.confirmVocabLink(tokenId));
  }

  // (The old _suggestMorphemeGloss "copy a gloss on link" write is gone: the
  // gloss-guess system shows the same suggestion as a placeholder in the cell
  // itself, and only writes it — with provenance — when the user confirms.)
  async _toggleVocab(tokenId, item, isLinked, returnFocus = false) {
    this._closePopover(returnFocus);
    if (isLinked) {
      await this._run(() => this.doc.unlinkVocab(tokenId));
    } else {
      await this._run(() => this.doc.linkVocab(tokenId, item.id));
    }
  }
  async _createVocab(tokenId, vocabId, form, returnFocus = false) {
    this._closePopover(returnFocus);
    if (!form) return;
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
        this._savedTimer = setTimeout(() => { this._statusState = 'idle'; this._paintStatus(); }, 1600);
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
    this.container
      .querySelectorAll('[data-suppress-commit]')
      .forEach((el) => { delete el.dataset.suppressCommit; });
    this.container.classList.toggle('igt-island--readonly', !!this.readOnly);
    // Vocab-linked projects show a hint line under every word/morpheme form;
    // the CSS reserves taller form rows for it (see --igt-form-h).
    this.container.classList.toggle('igt-island--vocab',
      Object.keys(this.doc.vocabularies || {}).length > 0);
    render(this._template(), this.container);
    this._restorePendingFocus();
    // Size sentence textareas to their content (uncontrolledValue may have just
    // written a programmatic value, e.g. on load / reload).
    this.container.querySelectorAll('textarea.igt-field--sentence').forEach((el) => this._autoGrow(el));
  }

  _restorePendingFocus() {
    const pf = this._pendingFocus;
    this._pendingFocus = null;
    if (!pf) return;
    // If the user already moved focus into another field while the structural op
    // was in flight, don't yank it back to the computed target (review: focus theft).
    const active = document.activeElement;
    if (active && active !== this.container && this.container.contains(active)
        && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
      return;
    }
    let el = null;
    if (pf.wordId != null && pf.precedence != null) {
      el = this.container.querySelector(`.igt-morph-field[data-word="${pf.wordId}"][data-prec="${pf.precedence}"]`);
    }
    if (!el) return;
    el.focus();
    const c = pf.cursor === 'end' ? el.value.length : (typeof pf.cursor === 'number' ? pf.cursor : el.value.length);
    try { el.setSelectionRange(c, c); } catch { /* not selectable */ }
  }

  // ---- field event helpers ----
  _onFieldFocus = (e) => {
    e.target.dataset.orig = e.target.value;
    try { e.target.select(); } catch { /* noop */ }
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
  };

  // Guess confirmation: Enter/Tab on an empty cell showing a guess adopts the
  // guess into the input value (marked confirmed so the blur-commit attaches
  // provenance) and then proceeds with normal navigation, whose focus change
  // blurs and commits. Typing replaces the guess (it's just a placeholder);
  // plain blur leaves the cell empty — guesses are never written implicitly.
  _maybeConfirmGuess(el) {
    if (el.value === '' && el.dataset.guessValue) {
      el.value = el.dataset.guessValue;
      el.dataset.guessConfirmed = '1';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // Ctrl/Cmd+Enter on any cell of a word column: confirm the WHOLE word's
  // machine-unverified analysis (segmentation, links, values) in one gesture,
  // then hop to the same-tier cell of the NEXT word — the review flow is
  // "glance, Ctrl+Enter, glance, Ctrl+Enter" across a sentence. Deliberate —
  // plain Enter must stay safe to navigate with. The hop skips the rest of
  // the current word (it was just confirmed wholesale, cell-by-cell movement
  // through it adds nothing) and advances even when nothing needed confirming,
  // so the gesture rides smoothly across mixed machine/human words.
  _maybeConfirmWord(e) {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return false;
    const wordId = e.target.dataset.confirmWord;
    if (!wordId || this.readOnly) return false;
    e.preventDefault();
    this._run(() => this.doc.confirmWordAnalysis(wordId));
    if (!this._advanceToNextWord(e.target, wordId)) e.target.blur();
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
        try { f.select(); } catch { /* not selectable */ }
        return true;
      }
    }
    return false;
  }

  _basicKeydown = (e) => {
    if (this._maybeConfirmWord(e)) return;
    if (e.key === 'Enter' || e.key === 'Tab') this._maybeConfirmGuess(e.target);
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

  // All focusable editable cells in DOM order (disabled inputs are excluded —
  // they aren't navigation targets).
  _navFields() {
    return [...this.container.querySelectorAll('.igt-field')]
      .filter((el) => !el.disabled);
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
        if (s != null && s < bestScore) { bestScore = s; best = el; }
      }
      return best;
    };

    // Pass 1: strictly within the current screen row / column band.
    let best = pick((el, ex, ey) => {
      if (dir === 'next') return (Math.abs(ey - cy) <= rowTol && ex > cx + 1) ? ex - cx : null;
      if (dir === 'prev') return (Math.abs(ey - cy) <= rowTol && ex < cx - 1) ? cx - ex : null;
      if (dir === 'down') return (ey > cy + 1 && Math.abs(ex - cx) <= colTol) ? (ey - cy) + Math.abs(ex - cx) * 3 : null;
      return (ey < cy - 1 && Math.abs(ex - cx) <= colTol) ? (cy - ey) + Math.abs(ex - cx) * 3 : null;
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
    try { best.select(); } catch { /* not selectable */ }
    return true;
  }

  // Commit an annotation/orthography cell on blur if its value changed. Routed
  // through the op chain so it serializes with structural edits. A value
  // adopted from a guess (see _maybeConfirmGuess) carries provenance metadata.
  _commitField(e, apply) {
    if (this.readOnly) return;
    const el = e.target;
    if (el.dataset.suppressCommit) { delete el.dataset.suppressCommit; return; }
    const next = el.value;
    const prov = el.dataset.guessConfirmed === '1' && next === el.dataset.guessValue
      ? confirmedGuessProvenance(el.dataset.guessSource || 'unknown')
      : null;
    delete el.dataset.guessConfirmed;
    if (next === (el.dataset.orig ?? '')) return;
    this._run(() => apply(next, prov));
  }

  _field({ key, value, apply, extraClass = '', sentence = false, ariaLabel, guess = null, prov = null, confirmWord = null }) {
    const v = value ?? '';
    const filled = v !== '';
    // A guess renders as a styled placeholder: the input VALUE stays empty, so
    // nothing persists unless explicitly confirmed (Enter/Tab — see
    // _maybeConfirmGuess) and stats/jump still see the cell as empty.
    const g = !sentence && !filled && !this.readOnly && guess ? guess : null;
    // Sentence-scoped fields (e.g. free Translation) are full free-text values —
    // an auto-growing textarea that wraps, rather than a one-line scrolling input.
    if (sentence) {
      return html`<textarea
        class="igt-field igt-field--sentence ${filled ? 'igt-field--filled' : 'igt-field--empty'} ${extraClass}"
        data-cell-key=${key}
        aria-label=${ariaLabel ?? nothing}
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
    return html`<input
      class="igt-field ${filled ? 'igt-field--filled' : 'igt-field--empty'} ${g ? 'igt-field--guess' : ''} ${p ? `igt-field--${p}` : ''} ${extraClass}"
      data-cell-key=${key}
      data-guess-value=${g ? g.value : nothing}
      data-guess-source=${g ? g.source : nothing}
      data-confirm-word=${confirmWord ?? nothing}
      aria-label=${ariaLabel ?? nothing}
      title=${g ? `Guess: ${g.value} — Enter confirms, typing replaces` : (p ? `${v} — ${PROV_TITLE[p]}` : (filled ? v : (ariaLabel ?? nothing)))}
      placeholder=${g ? g.value : nothing}
      size=${this._fieldSize(g ? g.value : v)}
      ?disabled=${this.readOnly}
      ${uncontrolledValue(v)}
      @focus=${this._onFieldFocus}
      @input=${this._onFieldInput}
      @keydown=${this._basicKeydown}
      @blur=${(e) => this._commitField(e, apply)}
    >`;
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
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.blur(); }
    else if (e.key === 'Tab') {
      if (this._navMove(e.target, e.shiftKey ? 'prev' : 'next')) e.preventDefault();
    }
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.target.value = e.target.dataset.orig ?? '';
      this._autoGrow(e.target);
      e.target.blur();
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
      if (this._maybeConfirmWord(e)) return;
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
      if (e.key === 'ArrowDown') { if (this._navMove(e.target, 'down')) e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { if (this._navMove(e.target, 'up')) e.preventDefault(); return; }
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

      if (e.key === '-') {
        if (e.altKey) {
          // Alt+- inserts a literal hyphen (clitic / reduplication forms) rather
          // than splitting the morpheme.
          e.preventDefault();
          const s = el.selectionStart ?? el.value.length;
          const en = el.selectionEnd ?? s;
          el.value = el.value.slice(0, s) + '-' + el.value.slice(en);
          const c = s + 1;
          try { el.setSelectionRange(c, c); } catch { /* noop */ }
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
        el.disabled = true; // block stale keystrokes during the async op
        this._pendingFocus = { wordId: word.id, precedence: (morph.precedence ?? 1) + 1, cursor: 0 };
        const ok = await this._run(() => this.doc.splitMorpheme(morph.id, left, right));
        el.disabled = false; // lit-html won't reset it (readOnly binding unchanged)
        if (!ok) restore(orig);
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
          this._pendingFocus = { wordId: word.id, precedence: (morph.precedence ?? 1) - 1, cursor: 'end' };
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
          this._pendingFocus = { wordId: word.id, precedence: prev.precedence ?? idx, cursor: prevLen };
          const ok = await this._run(() => this.doc.mergeMorphemes(morph.id));
          el.disabled = false;
          if (!ok) restore(null);
          return;
        }
      }
    };
  }

  // Paste-splitting: pasting text containing "-" into a morpheme form splits
  // it into a morpheme chain at the hyphens (the bulk-entry idiom from the
  // early single-input prototype — unambiguous here because the paste target
  // is a single known morpheme). Hyphen-free pastes fall through to the
  // browser default.
  _onMorphPaste(morph, word) {
    return async (e) => {
      if (this.readOnly) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text.includes('-')) return;
      e.preventDefault();
      const el = e.target;
      const s = el.selectionStart ?? el.value.length;
      const en = el.selectionEnd ?? s;
      const combined = el.value.slice(0, s) + text + el.value.slice(en);
      const segments = combined.split('-').map(x => x.trim()).filter(x => x !== '');
      if (segments.length <= 1) {
        // All hyphens were leading/trailing/doubled — just insert the cleaned text.
        el.value = segments[0] ?? '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      const orig = el.value;
      el.value = segments[0];
      el.dataset.suppressCommit = '1';
      el.disabled = true;
      this._pendingFocus = { wordId: word.id, precedence: (morph.precedence ?? 1) + segments.length - 1, cursor: 'end' };
      const ok = await this._run(() => this.doc.splitMorphemeMulti(morph.id, segments));
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
    if (el.dataset.suppressCommit) { delete el.dataset.suppressCommit; return; }
    const next = el.value;
    if (next === (el.dataset.orig ?? '')) return;
    this._run(() => this.doc.updateMorphemeForm(morphId, next));
  }

  // The gloss-guess source scans the WHOLE document (doc-frequency), so build
  // it once per data version and reuse across the many non-data re-renders
  // (popover open/keystroke, paging, help toggle…). Mirrors _homonymIndexFor.
  // Rebuilds if the pluggable factory is swapped (e.g. a service-backed source).
  _guessSource(sentences, wordFields, morphFields) {
    const dv = this.doc.dataVersion;
    if (this._guessCacheVersion !== dv || this._guessCacheFactory !== this.guessSourceFactory) {
      this._guessCacheVersion = dv;
      this._guessCacheFactory = this.guessSourceFactory;
      this._guessCache = this.guessSourceFactory(sentences, { wordFields, morphFields });
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
      return html`
        <div class="igt-island__empty igt-island__empty--warn">
          <div class="igt-empty__title">This document isn't set up for interlinear analysis yet</div>
          <p class="igt-empty__body">No primary <em>word</em> token layer is configured for this project. An
            administrator needs to finish project setup before the interlinear grid can be used.</p>
        </div>`;
    }
    const sentences = doc.sentences;
    const hasTokens = sentences.some((s) => s.tokens.length > 0);
    if (!hasTokens) {
      return html`
        <div class="igt-island__empty">
          <div class="igt-empty__title">Nothing to analyze yet</div>
          <p class="igt-empty__body">Interlinear glossing happens here once the text is split into words. Head to
            the <strong>Tokenize</strong> tab to break the baseline text into sentences and words first.</p>
          ${this.readOnly ? nothing : html`<button type="button" class="igt-empty__cta"
            @click=${(e) => { e.stopPropagation(); this._navigateTab('tokenize'); }}>Go to Tokenize →</button>`}
        </div>`;
    }

    const orthographies = (readOrthographies(info.primaryTokenLayer.config) || []).map((o) => o.name);
    const wordFields = info.spanLayers.word.map((l) => l.name);
    const morphFields = info.spanLayers.morpheme.map((l) => l.name);
    const sentFields = info.spanLayers.sentence.map((l) => l.name);
    const hasMorphemes = !!info.morphemeTokenLayer;
    const ignoredCfg = readIgnoredTokens(info.primaryTokenLayer.config);

    // Gloss guesses (pluggable — see domain/glossGuess.js; assign
    // this.guessSourceFactory to swap the algorithm). Rebuilt per data render;
    // null in read-only mode so historical views never show suggestions.
    const guess = this.readOnly ? null
      : this._guessSource(sentences, wordFields, morphFields);

    const ctx = { orthographies, wordFields, morphFields, sentFields, hasMorphemes, ignoredCfg, guess };

    // One page of sentences in the DOM (see PAGE_SIZE). Sentence numbering
    // stays GLOBAL; cross-page movement is handled by the pager and the search
    // click-through (_consumeFocusRequest pages first).
    const pageCount = Math.max(1, Math.ceil(sentences.length / IgtEditor.PAGE_SIZE));
    this._page = Math.min(Math.max(0, this._page), pageCount - 1);
    const pageStart = this._page * IgtEditor.PAGE_SIZE;
    const pageSentences = sentences.slice(pageStart, pageStart + IgtEditor.PAGE_SIZE);

    return html`
      ${this._toolbar(sentences, ctx, pageCount)}
      ${this._helpOpen ? this._legend(ctx) : nothing}
      ${doc.error ? html`<div class="igt-island__error" role="alert">${doc.error}</div>` : nothing}
      ${repeat(pageSentences, (s) => s.id, (s, i) => this._sentence(s, pageStart + i, ctx))}
      ${pageCount > 1 ? this._pager(sentences.length, pageCount, 'bottom') : nothing}
    `;
  }

  static PAGE_SIZE = 10;

  _setPage(page, scrollToTop = false) {
    if (page === this._page) return;
    this._page = page;
    this._render(true);
    if (scrollToTop) {
      try { this.container.scrollIntoView({ block: 'start' }); } catch { /* noop */ }
    }
  }

  _pager(total, pageCount, where) {
    const start = this._page * IgtEditor.PAGE_SIZE;
    const end = Math.min(total, start + IgtEditor.PAGE_SIZE);
    const btn = (label, target, title, disabled) => html`
      <button type="button" class="igt-pager__btn" ?disabled=${disabled} title=${title}
        @click=${(e) => { e.stopPropagation(); this._setPage(target, where === 'bottom'); }}>${label}</button>`;
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
  _glossStats(sentences, ctx) {
    if (!ctx.hasMorphemes || !ctx.morphFields.length) return null;
    let total = 0;
    let done = 0;
    for (const s of sentences) {
      for (const t of s.tokens) {
        for (const m of (t.morphemes || [])) {
          total += 1;
          if (ctx.morphFields.some((n) => (m.annotations?.[n]?.value ?? '') !== '')) done += 1;
        }
      }
    }
    return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  // Gloss-progress bar: held back pending a UX rethink (user call, 2026-06-10).
  // Flip to true to restore — markup, CSS, and _glossStats are all kept.
  static SHOW_GLOSS_PROGRESS = false;

  _toolbar(sentences, ctx, pageCount = 1) {
    // Only pay for the whole-document stats pass when the bar is actually shown.
    const stats = IgtEditor.SHOW_GLOSS_PROGRESS ? this._glossStats(sentences, ctx) : null;
    const nSent = sentences.length;
    return html`
      <div class="igt-toolbar">
        <div class="igt-toolbar__left">
          ${pageCount > 1
            ? this._pager(nSent, pageCount, 'top')
            : html`<span class="igt-toolbar__count">${nSent} sentence${nSent === 1 ? '' : 's'}</span>`}
          ${IgtEditor.SHOW_GLOSS_PROGRESS && stats ? html`
            <span class="igt-progress" title=${`${stats.done} of ${stats.total} morphemes have a gloss`}>
              <span class="igt-progress__bar"><span class="igt-progress__fill" style=${`width:${stats.pct}%`}></span></span>
              <span class="igt-progress__text">${stats.done}/${stats.total} glossed</span>
            </span>
          ` : nothing}
          ${!this.readOnly && Object.keys(this.doc.vocabularies || {}).length > 0
            ? html`<button type="button" class="igt-toolbar__btn"
                title="Link words and morphemes to the lexicon — choose the built-in rule or a linking service. Auto-links show in violet until you confirm them."
                @click=${(e) => { e.stopPropagation(); this._openAutoLink(); }}>
                Auto-link…
              </button>`
            : nothing}
        </div>
        <div class="igt-toolbar__right">
          <span class="igt-status" role="status" aria-live="polite" data-state=${this._statusState || 'idle'}></span>
          <button type="button" class="igt-help-btn" aria-expanded=${this._helpOpen ? 'true' : 'false'}
            aria-label="Keyboard & scope help" title="Keyboard & scope help"
            @click=${(e) => { e.stopPropagation(); this._toggleHelp(); }}>?</button>
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
          ${ctx.hasMorphemes ? html`<span class="igt-legend__chip igt-legend__chip--morph">Morpheme</span>` : nothing}
          <span class="igt-legend__chip igt-legend__chip--sent">Sentence</span>
        </div>
        <div class="igt-legend__row">
          <strong>Navigate</strong>
          <span><kbd>Enter</kbd>/<kbd>Tab</kbd> next cell in the same row · <kbd>⇧</kbd>+ previous · <kbd>↑</kbd><kbd>↓</kbd> move rows · <kbd>Esc</kbd> cancel edit</span>
        </div>
        ${ctx.hasMorphemes ? html`
          <div class="igt-legend__row">
            <strong>Morphemes</strong>
            <span>type <kbd>-</kbd> to split (pasting <em>a-b-c</em> splits too) · <kbd>⌫</kbd> at start merges with previous · <kbd>Alt</kbd>+<kbd>-</kbd> literal hyphen</span>
          </div>` : nothing}
        <div class="igt-legend__row">
          <strong>Guesses</strong>
          <span>violet italic values are guesses from matching forms — <kbd>↵</kbd>/<kbd>Tab</kbd> confirms, typing replaces, leaving the cell discards</span>
        </div>
        <div class="igt-legend__row">
          <strong>Provenance</strong>
          <span><span class="igt-legend__prov igt-legend__prov--machine">violet italic</span> = machine-made, unverified ·
            <span class="igt-legend__prov igt-legend__prov--verified">violet underline</span> = machine-made, confirmed by a person ·
            plain = made by a person · editing a value confirms it · <kbd>Ctrl</kbd>+<kbd>↵</kbd> confirms a whole word and jumps to the next</span>
        </div>
        <div class="igt-legend__row">
          <strong>Lexicon</strong>
          <span>hover a word or morpheme and click <em>+ link</em> to link it to a lexicon entry · <em>Auto-link</em> links everything that follows project precedent or matches one entry — violet links are auto-made; open one and click it (or <em>confirm</em>) to approve</span>
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
    const fields = { morphFields: ctx.morphFields, wordFields: ctx.wordFields, sentFields: ctx.sentFields };
    const text = formatSentence(sentence, fields, format);
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
      try { document.execCommand('copy'); } finally { ta.remove(); }
    }
    this._copyMenu = null;
    this._copiedFlash = sentence.id;
    clearTimeout(this._copiedTimer);
    this._copiedTimer = setTimeout(() => { this._copiedFlash = null; this._render(true); }, 1400);
    this._render(true);
  }

  _copyControl(sentence, ctx) {
    const fav = this._favoriteCopyFormat();
    const favLabel = COPY_FORMATS.find((f) => f.id === fav)?.label ?? fav;
    const open = this._copyMenu === sentence.id;
    const copied = this._copiedFlash === sentence.id;
    return html`
      <div class="igt-copy" @click=${(e) => e.stopPropagation()}>
        <button type="button" class="igt-copy__btn"
          title=${`Copy as IGT — ${favLabel}`}
          @click=${() => this._copySentence(sentence, ctx, fav)}>
          ${copied ? 'Copied ✓' : 'Copy'}
        </button>
        <button type="button" class="igt-copy__caret" aria-label="Choose copy format"
          aria-expanded=${open ? 'true' : 'false'}
          @click=${() => { this._copyMenu = open ? null : sentence.id; this._render(true); }}>
          ▾
        </button>
        ${open ? html`
          <div class="igt-copy__menu" role="menu">
            ${COPY_FORMATS.map((f) => html`
              <button type="button" class="igt-copy__item ${f.id === fav ? 'is-fav' : ''}" role="menuitem"
                @click=${() => {
                  localStorage.setItem(COPY_FORMAT_STORAGE_KEY, f.id);
                  this._copySentence(sentence, ctx, f.id);
                }}>
                <span>${f.label}</span>
                ${f.id === fav ? html`<span class="igt-copy__fav">★</span>` : nothing}
              </button>
            `)}
            <div class="igt-copy__hint">picking a format makes it the default</div>
          </div>` : nothing}
      </div>
    `;
  }

  _sentence(sentence, index, ctx) {
    // Render word columns interleaved with the baseline text that no word token
    // covers (punctuation, stray characters): each such run gets a slim,
    // non-editable "gap" column so it stays visible in its true position.
    // Whitespace-only gaps (ordinary inter-word spacing) are dropped.
    const cols = sentence.pieces.filter(
      (p) => p.isToken || (p.content || '').trim() !== '');
    return html`
      <div class="igt-sentence" data-sentence-id=${sentence.id} role="group" aria-label=${`Sentence ${index + 1}`}>
        <h3 class="igt-sr-only">Sentence ${index + 1}</h3>
        <span class="igt-sentence__num" aria-hidden="true">${index + 1}</span>
        ${this._copyControl(sentence, ctx)}
        <div class="igt-grid">
          <div class="igt-tokens">
            ${this._labels(ctx)}
            ${repeat(
              cols,
              (p) => (p.isToken ? p.id : `gap:${p.begin}-${p.end}`),
              (p) => (p.isToken ? this._tokenCol(p, ctx) : this._gapCol(p)))}
          </div>
        </div>
        ${this._sentenceAnnos(sentence, index, ctx)}
      </div>
    `;
  }

  _labels(ctx) {
    return html`
      <div class="igt-labels">
        <div class="igt-row-label igt-row-label--spacer"></div>
        ${ctx.orthographies.map((n) => html`<div class="igt-row-label igt-row-label--orth" title=${`${n} (orthography)`}>${n}</div>`)}
        ${ctx.wordFields.map((n) => html`<div class="igt-row-label igt-row-label--word" title=${`${n} (word)`}>${n}</div>`)}
        ${ctx.hasMorphemes ? html`<div class="igt-row-label igt-row-label--morph igt-row-label--morphform">Morphemes</div>` : nothing}
        ${ctx.hasMorphemes ? ctx.morphFields.map((n) => html`<div class="igt-row-label igt-row-label--morph" title=${`${n} (morpheme)`}>${n}</div>`) : nothing}
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
      return this._inertCol(token.content, `${token.content} — excluded from annotation`);
    }
    return html`
      <div class="igt-token-col">
        <div class="igt-token-form" title=${token.content}>
          ${this._vocabFace(token.content, { id: token.id, vocabItem: token.vocabItem, formText: token.content, kind: 'word' })}
        </div>
        ${ctx.orthographies.map((name) => html`
          <div class="igt-cell">
            ${this._field({
              key: `or:${token.id}:${name}`,
              value: token.orthographies?.[name] ?? '',
              apply: (v) => this.doc.updateOrthography(token.id, name, v),
              ariaLabel: `${name} for ${token.content}`,
            })}
          </div>
        `)}
        ${ctx.wordFields.map((name) => html`<div class="igt-cell">
            ${this._field({
              key: `wa:${token.id}:${name}`,
              value: token.annotations?.[name]?.value ?? '',
              apply: (v, prov) => this.doc.updateTokenSpan(token.id, name, v, prov),
              ariaLabel: `${name} for ${token.content}`,
              guess: ctx.guess?.guessFor('word', token.content, name) ?? null,
              prov: spanProv(token.annotations?.[name]),
              confirmWord: token.id,
            })}
          </div>`)}
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
    return this._inertCol(text, `${text} — not part of any word`);
  }

  _morphemes(token, ctx) {
    const morphemes = token.morphemes || [];
    // The affix joint ("-", or "=" for clitics) belongs to the BOUNDARY, not to
    // either morpheme — it renders between the columns, straddling the gap.
    return html`
      <div class="igt-morphemes">
        ${repeat(morphemes, (m) => m.id, (m, i) => {
          const joiner = i > 0
            ? morphemeJoiner(morphemes[i - 1]?.metadata?.morphType, m.metadata?.morphType)
            : null;
          return html`
            ${joiner ? html`<span class="igt-morph-joiner" aria-hidden="true">${joiner}</span>` : nothing}
            ${this._morphCol(m, token, morphemes, ctx)}
          `;
        })}
      </div>
    `;
  }

  _morphCol(morph, word, siblings, ctx) {
    const value = morphFormOf(morph);
    const filled = value !== '';
    // Chips linked to a stem/root lexicon entry keep the lavender accent —
    // a coverage cue for lexical identification; everything else stays quiet.
    const stem = isStemType(morph.vocabItem?.metadata?.morphType);
    // Machine-made segmentation (copied analyses) marks the morpheme TOKEN's
    // metadata; the form cell carries the unverified/verified styling.
    const prov = metaProv(morph.metadata);
    return html`
      <div class="igt-morph-col">
        <div class="igt-morph-form ${stem ? 'igt-morph-form--stem' : ''}">
          ${this._vocabFace(
            html`<input
              class="igt-field igt-morph-field ${filled ? 'igt-field--filled' : 'igt-field--empty'} ${prov ? `igt-field--${prov}` : ''}"
              data-cell-key=${`mf:${morph.id}`}
              data-word=${word.id}
              data-prec=${morph.precedence ?? 1}
              data-confirm-word=${word.id}
              aria-label=${`Morpheme form${value ? ` ${value}` : ''}`}
              title=${prov ? `${value} — ${PROV_TITLE[prov]}` : (filled ? value : nothing)}
              size=${this._fieldSize(value)}
              ?disabled=${this.readOnly}
              ${uncontrolledValue(value)}
              @focus=${this._onMorphFormFocus}
              @input=${this._onFieldInput}
              @keydown=${this._morphFormKeydown(morph, word, siblings)}
              @paste=${this._onMorphPaste(morph, word)}
              @blur=${(e) => this._commitMorphForm(e, morph.id)}
            >`,
            { id: morph.id, vocabItem: morph.vocabItem, formText: value, kind: 'morpheme' },
          )}
        </div>
        ${ctx.morphFields.map((name) => html`
          <div class="igt-morph-cell">
            ${this._field({
              key: `ma:${morph.id}:${name}`,
              value: morph.annotations?.[name]?.value ?? '',
              apply: (v, prov) => this.doc.updateMorphemeSpan(morph.id, name, v, prov),
              extraClass: 'igt-morph-field',
              ariaLabel: `${name} for morpheme${value ? ` ${value}` : ''}`,
              guess: ctx.guess?.guessFor('morpheme', value, name) ?? null,
              prov: spanProv(morph.annotations?.[name]),
              confirmWord: word.id,
            })}
          </div>
        `)}
      </div>
    `;
  }

  _sentenceAnnos(sentence, index, ctx) {
    if (!ctx.sentFields.length) return nothing;
    return html`
      <div class="igt-sentence-annos">
        ${ctx.sentFields.map((name) => html`
          <div class="igt-sentence-anno">
            <span class="igt-sentence-anno__label">${name}</span>
            ${this._field({
              key: `sa:${sentence.id}:${name}`,
              value: sentence.annotations?.[name]?.value ?? '',
              apply: (v) => this.doc.updateSentenceSpan(sentence.id, name, v),
              sentence: true,
              ariaLabel: `${name} for sentence ${index + 1}`,
            })}
          </div>
        `)}
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
    const open = this._popover && this._popover.tokenId === id;
    const canLink = hasVocabs && !this.readOnly;
    const openerClick = (e) => {
      e.stopPropagation();
      open ? this._closePopover() : this._openPopover(id, kind, e.currentTarget);
    };
    let opener = nothing;
    if (vocabItem) {
      // Three-way provenance: human links plain, machine-unverified violet
      // ("inferred"), machine-verified quietly marked.
      const state = vocabItem.prov ?? PROV_STATES.HUMAN;
      const stateClass = state === PROV_STATES.MACHINE ? 'igt-vocab__hint--inferred'
        : state === PROV_STATES.VERIFIED ? 'igt-vocab__hint--verified' : '';
      const title = state === PROV_STATES.MACHINE
        ? `Auto-linked to "${vocabItem.form}" — open to confirm or change`
        : state === PROV_STATES.VERIFIED
          ? `Linked to "${vocabItem.form}" — auto-linked, confirmed${canLink ? ' · manage' : ''}`
          : `Linked to "${vocabItem.form}"${canLink ? ' — manage' : ''}`;
      const sub = this._homonymSub(vocabItem);
      opener = html`<button type="button" class="igt-vocab__opener igt-vocab__hint ${stateClass}"
        data-vocab-opener=${id} ?disabled=${!canLink}
        title=${title}
        @click=${openerClick}>${vocabItem.form}${sub != null ? html`<sub class="igt-vocab__sub">${sub}</sub>` : nothing}</button>`;
    } else if (canLink) {
      opener = html`<button type="button" class="igt-vocab__opener igt-vocab__link"
        data-vocab-opener=${id} title="Link to a lexicon entry"
        @click=${openerClick}>link</button>`;
    }
    return html`
      <span class="igt-vocab">
        ${face}
        ${opener}
        ${open ? this._vocabPopover(id, formText, vocabItem, kind) : nothing}
      </span>
    `;
  }

  // Homonym subscripts (form₂) for vocab items that share a form within a
  // vocab — FLEx-style sense numbering by creation order. Cached per
  // doc.dataVersion so we regroup only when the data actually changes.
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
    return (inlineNames.length ? vals.join(' · ') : (vals[0] ?? ''));
  }

  _vocabPopover(tokenId, formText, currentItem, kind) {
    const vocabs = Object.values(this.doc.vocabularies || {});
    // The popover is scoped to ONE vocabulary at a time, chosen by the thin
    // selector at the bottom. Default to the linked item's vocab (so an existing
    // link is visible), else the first. The list, create, and manage row all
    // follow the active vocab.
    const activeVocab = vocabs.find((v) => v.id === this._popoverVocabId)
      || vocabs.find((v) => v.id === currentItem?.vocabId)
      || vocabs[0]
      || null;
    this._popoverVocabId = activeVocab?.id ?? null;

    const search = (this._popoverSearch || '').toLowerCase();
    const ft = (formText || '').toLowerCase();
    const homIdx = activeVocab ? this._homonymIndexFor(activeVocab.id) : null;
    let items = (activeVocab?.items || []).map((it) => ({
      ...it,
      _detail: this._vocabItemDetail(it, activeVocab),
      _sub: homIdx ? homIdx.get(it.id) : null,
    }));

    // Rank against the active query: the typed search if any, else the
    // word/morpheme's own form. Tiers (exact > prefix > substring on the form
    // > match in the detail text > fuzzy), Levenshtein within a tier. While
    // searching, fuzzy-only "matches" are dropped — typing narrows.
    const q = search || ft;
    const tierOf = (it) => {
      const form = (it.form || '').toLowerCase();
      if (!q) return 4;
      if (form === q) return 0;
      if (form.startsWith(q)) return 1;
      if (form.includes(q)) return 2;
      if ((it._detail || '').toLowerCase().includes(q)) return 3;
      return 4;
    };
    if (search) items = items.filter((it) => tierOf(it) < 4);
    items.sort((a, b) => {
      const t = tierOf(a) - tierOf(b);
      if (t !== 0) return t;
      return levenshtein(q, (a.form || '').toLowerCase()) - levenshtein(q, (b.form || '').toLowerCase());
    });
    if (currentItem) {
      const i = items.findIndex((it) => it.id === currentItem.id);
      if (i > 0) { const [x] = items.splice(i, 1); items.unshift(x); }
    }
    const limited = items.slice(0, 30);
    const truncated = items.length - limited.length;
    // A single "+ Create" row, into the active vocab, when there's a form.
    const canCreate = !!(formText && activeVocab);
    // If the form already exists in the active vocab, the new item would be a
    // homonym — preview the subscript it would get (existing count + 1).
    const newFormDupes = canCreate ? (activeVocab.items || []).filter((it) => it.form === formText).length : 0;
    const newFormSub = newFormDupes >= 1 ? newFormDupes + 1 : null;
    // Rows the keyboard can land on: every item plus the create row.
    const total = limited.length + (canCreate ? 1 : 0);
    const activeIdx = Math.min(this._popoverActiveIndex ?? 0, Math.max(0, total - 1));
    const pos = this._popoverPos;
    const posStyle = pos ? `position:fixed;left:${pos.left}px;top:${pos.top}px;transform:none;margin-top:0;` : '';

    // For an INFERRED link, selecting the linked row CONFIRMS it (the human
    // gesture that flips provConfirmed); for a human link it unlinks (toggle),
    // as before. The explicit "unlink" mini-action is always available.
    const inferredCurrent = !!currentItem?.inferred;
    const selectActive = () => {
      if (activeIdx < limited.length) {
        const it = limited[activeIdx];
        const linked = currentItem && it.id === currentItem.id;
        if (linked && inferredCurrent) this._confirmLink(tokenId, true);
        else this._toggleVocab(tokenId, it, linked, true);
      } else if (canCreate) {
        this._createVocab(tokenId, activeVocab.id, formText, true);
      }
    };
    const onSearchKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this._closePopover(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this._movePopoverActive(1, total); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this._movePopoverActive(-1, total); }
      else if (e.key === 'Enter') { e.preventDefault(); selectActive(); }
      else if (e.key === 'Tab') { e.preventDefault(); } // trap focus in the search box
    };
    const selectVocab = (id) => {
      this._popoverVocabId = id;
      this._popoverActiveIndex = 0;
      this._render(true);
    };

    return html`
      <div class="igt-vocab-pop" style=${posStyle} role="dialog" aria-label="Link to lexicon"
        @click=${(e) => e.stopPropagation()}>
        <input class="igt-vocab-pop__search" placeholder="Search lexicon…"
          aria-label="Search lexicon"
          .value=${live(this._popoverSearch || '')}
          @input=${(e) => { this._popoverSearch = e.target.value; this._popoverActiveIndex = 0; this._render(true); }}
          @keydown=${onSearchKey}>
        <div class="igt-vocab-pop__list">
          ${limited.length
            ? limited.map((it, i) => {
                const linked = currentItem && it.id === currentItem.id;
                const confirmable = linked && inferredCurrent;
                return html`<button type="button" class="igt-vocab-pop__item ${linked ? 'is-linked' : ''} ${i === activeIdx ? 'is-active' : ''}"
                  @mousemove=${() => { if (this._popoverActiveIndex !== i) { this._popoverActiveIndex = i; this._render(true); } }}
                  @click=${(e) => {
                    e.stopPropagation();
                    if (confirmable) this._confirmLink(tokenId);
                    else this._toggleVocab(tokenId, it, linked);
                  }}>
                  <span class="igt-vocab-pop__main">
                    <span class="igt-vocab-pop__form">${it.form}${it._sub != null ? html`<sub class="igt-vocab-pop__sub">${it._sub}</sub>` : nothing}</span>
                    ${confirmable ? html`<span class="igt-vocab-pop__ok">confirm</span>` : nothing}
                    ${linked ? html`<span class="igt-vocab-pop__x" role="button" tabindex="-1"
                      @click=${(e) => { e.stopPropagation(); this._toggleVocab(tokenId, it, true); }}>unlink</span>` : nothing}
                  </span>
                  ${it._detail ? html`<span class="igt-vocab-pop__detail">${it._detail}</span>` : nothing}
                </button>`;
              })
            : html`<div class="igt-vocab-pop__empty">No matches</div>`}
          ${truncated > 0
            ? html`<div class="igt-vocab-pop__more">+ ${truncated} more — type to narrow</div>`
            : nothing}
        </div>
        ${canCreate
          ? html`<button type="button" class="igt-vocab-pop__create ${activeIdx === limited.length ? 'is-active' : ''}"
              @mousemove=${() => { const idx = limited.length; if (this._popoverActiveIndex !== idx) { this._popoverActiveIndex = idx; this._render(true); } }}
              @click=${(e) => { e.stopPropagation(); this._createVocab(tokenId, activeVocab.id, formText); }}>
              + Create "${formText}${newFormSub != null ? html`<sub class="igt-vocab-pop__sub">${newFormSub}</sub>` : nothing}"
            </button>`
          : nothing}
        ${kind === 'morpheme' ? this._morphTypeRow(tokenId) : nothing}
        ${vocabs.length
          ? html`<div class="igt-vocab-pop__vocabsel" role="tablist" aria-label="Choose lexicon">
              ${vocabs.map((v) => {
                const isActive = v.id === activeVocab?.id;
                // An inactive chip scopes the popover to that lexicon; the active
                // chip is a link to the full vocab view (new tab). So the first
                // click selects, a second click on the now-active chip opens.
                return isActive
                  ? html`<a class="igt-vocab-pop__vocabtab is-active" role="tab" aria-selected="true"
                      href=${`#/vocabularies/${v.id}`} target="_blank" rel="noopener"
                      title=${`Open “${v.name}” in a new tab`}
                      @click=${(e) => e.stopPropagation()}><span class="igt-vocab-pop__vtab-name">${v.name}</span><span class="igt-vocab-pop__vtab-ext">↗</span></a>`
                  : html`<button type="button" class="igt-vocab-pop__vocabtab" role="tab" aria-selected="false"
                      title=${`Switch to “${v.name}”`}
                      @click=${(e) => { e.stopPropagation(); selectVocab(v.id); }}><span class="igt-vocab-pop__vtab-name">${v.name}</span></button>`;
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
  _morphTypeRow(morphemeId) {
    const morph = (this.doc.layerInfo.morphemeTokenLayer?.tokens || [])
      .find((m) => m.id === morphemeId);
    const current = morph?.metadata?.morphType ?? '';
    return html`
      <label class="igt-vocab-pop__type" @click=${(e) => e.stopPropagation()}>
        <span>Type</span>
        <select ?disabled=${this.readOnly} aria-label="Morpheme type"
          @change=${(e) => { e.stopPropagation(); this.doc.setMorphemeType(morphemeId, e.target.value || null); }}>
          <option value="" ?selected=${current === ''}>—</option>
          ${FLEX_MORPH_TYPES.map((t) => html`<option value=${t} ?selected=${current === t}>${t}</option>`)}
        </select>
      </label>
    `;
  }
}
