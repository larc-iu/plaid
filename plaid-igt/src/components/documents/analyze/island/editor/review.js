import { notifyInfo } from '@/utils/feedback';
import { ADVANCE_BEAT_MS, PULSE_CLASS, PULSE_MS, reviewSelector, reviewStates } from './shared.js';

// Reviewing proposals: the beat and pulse that say a confirmation landed,
// Ctrl+Enter and Ctrl+Backspace on a word, the jump between unverified
// words, and the chip-to-chip sweep over auto-linked entries.
export const review = {
  // Confirming and hopping used to happen in the same frame, so you saw
  // neither: the word went from violet to plain exactly as the browser jumped
  // the view to reveal the next cell. A beat between them is enough to see
  // what you just did.
  //
  // The beat is on the FOCUS MOVE, not on a scroll of our own. Moving focus is
  // what makes the browser reveal the next cell, and revealing focus is its
  // job, not ours -- past that the scroll position is the reader's to control.
  //
  // Anything the reader does DURING the beat flushes it immediately: a second
  // Ctrl+Enter, or any keystroke at all. Without that, holding the key down
  // would stack delays, and a character typed in the window would land in the
  // cell being left rather than the one being moved to.
  _afterABeat(run) {
    this._flushBeat();
    this._beat = { run, timer: setTimeout(() => this._flushBeat(), ADVANCE_BEAT_MS) };
  },

  _flushBeat() {
    const beat = this._beat;
    if (!beat) return;
    this._beat = null;
    clearTimeout(beat.timer);
    beat.run();
  },

  // Something says it took the confirmation. Restarted rather than queued, so a
  // fast run of the gesture pulses each target in turn instead of falling
  // behind.
  //
  // The class goes on a wrapper, never on the input or the chip itself. lit
  // rewrites a bound class attribute WHOLESALE, taking a hand-added class with
  // it, and a confirmation re-renders the grid. An input's class carries its
  // filled/empty and provenance state, so it is rewritten by the very
  // mutation being announced. The wrappers survive: `.igt-token-col` and
  // `.igt-vocab` are static, and `.igt-cell`/`.igt-morph-cell`/
  // `.igt-sentence-anno` interpolate only _rowCls, which says whether the row
  // is COLLAPSED and so cannot change while a confirmation is landing. (If
  // _rowCls ever grows a second input, these pulses get cut short and the
  // wrappers need a static class of their own.) All of them are transparent,
  // so the wash reads as the cell's or the link's own.
  _pulse(el) {
    if (!el) return;
    el.classList.remove(PULSE_CLASS);
    void el.offsetWidth; // restart the animation rather than ignore a re-add
    el.classList.add(PULSE_CLASS);
    setTimeout(() => el.classList.remove(PULSE_CLASS), PULSE_MS);
  },

  _pulseWord(wordId) {
    this._pulse(this.container.querySelector(`[data-word-col="${wordId}"]`));
  },

  // The wash for a link: the chip's whole stack, so the form above it is lit
  // too. That is the unit a link is about, and the chip alone is a few pixels
  // tall.
  _pulseLink(openerId) {
    const opener = this.container.querySelector(`[data-vocab-opener="${openerId}"]`);
    this._pulse(opener?.closest('.igt-vocab') ?? opener);
  },

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
    this._pulseWord(wordId);
    const from = e.target;
    this._afterABeat(() => {
      if (!this._advanceToNextWord(from, wordId)) {
        // Last word on the page: commit (blur) but keep the caret here rather
        // than dropping focus to <body> (E2). Re-affirmed after the re-render.
        const key = from.dataset.cellKey;
        from.blur();
        this._pendingFocus = { cellKey: key };
        const same = key ? this.container.querySelector(`[data-cell-key="${key}"]`) : null;
        if (same) same.focus();
      } else if (adoptions.length) {
        // Adopting reloads the document (new spans), which re-renders the grid
        // out from under the hop target: re-affirm it the way discard does.
        const key = document.activeElement?.dataset?.cellKey;
        if (key) this._pendingFocus = { cellKey: key };
      }
    });
    return true;
  },

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
        metadata: this.doc.adoptStamp(el.dataset.guessSource || 'unknown', { value }),
      });
    }
    return out;
  },

  // The selector for material this writer reviews in a word column — the
  // review sweep's stops and what Ctrl+Enter / Ctrl+Backspace act on.
  _reviewColSelector() {
    return reviewSelector(
      ['.igt-field', '.igt-token-form', (s) => `button.igt-vocab__hint--${s}:not([disabled])`],
      this.doc.isContributor,
    );
  },

  // Whether an element carries one of the review states this writer acts on.
  _isReviewable(el, base) {
    return reviewStates(this.doc.isContributor).some((s) => el.classList.contains(`${base}--${s}`));
  },

  // Whether this word column holds any material this writer reviews — the
  // same selector the review sweep uses to find its next stop.
  _wordHasUnverified(wordId) {
    const col = this.container.querySelector(`[data-word-col="${wordId}"]`);
    return !!col?.querySelector(this._reviewColSelector());
  },

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
    // Claimed only over an UNTOUCHED cell, as in a translation field: with
    // text typed and not yet saved this is the browser's own delete-a-word,
    // and hopping away (with the commit suppressed) would drop what was typed.
    if (e.target.value !== (e.target.dataset.orig ?? '')) return false;
    e.preventDefault();
    // Like confirm, hold position when there is nothing to act on: a hop with
    // no visible change reads as a discard that never happened, and the
    // suppressed commit used to leave the cell showing text nobody saved.
    if (!this._wordHasUnverified(wordId)) {
      notifyInfo(
        'Everything here was made by a person already. Only unverified proposals can be discarded this way.',
        'Nothing to discard on this word',
      );
      return true;
    }
    e.target.dataset.suppressCommit = '1';
    this._run(() => this.doc.discardWordAnalysis(wordId));
    if (this._advanceToNextWord(e.target, wordId)) {
      const key = document.activeElement?.dataset?.cellKey;
      if (key) this._pendingFocus = { cellKey: key };
    } else {
      // Last word on the page: stay here rather than dropping focus to <body>,
      // as confirm does. The reload may remove this very cell (a discarded
      // machine morpheme takes its gloss cells with it), so the word's first
      // remaining cell is the fallback.
      const key = e.target.dataset.cellKey;
      e.target.blur();
      this._pendingFocus = { cellKey: key, wordId };
      const same = key ? this.container.querySelector(`[data-cell-key="${key}"]`) : null;
      if (same) same.focus();
    }
    return true;
  },

  // The words on this page with any machine-unverified material (cells or
  // link chips), each represented by its first such element in DOM order:
  // the review sweep's "next word that needs a look" targets.
  _unverifiedWordAnchors() {
    const anchors = [];
    const seen = new Set();
    const contributor = this.doc.isContributor;
    const els = this.container.querySelectorAll(this._reviewColSelector());
    for (const el of els) {
      const col = el.closest('[data-word-col]');
      const wordId = col?.dataset.wordCol;
      if (!wordId || seen.has(wordId)) continue;
      seen.add(wordId);
      // Prefer a marked CELL in the column (where Ctrl+Enter / Ctrl+Backspace
      // act on the word); a column whose only marked material is a link
      // lands on the chip.
      const target =
        col.querySelector(reviewSelector(['.igt-field'], contributor)) ||
        (el.matches('input, button')
          ? el
          : col.querySelector(
              reviewSelector([(s) => `button.igt-vocab__hint--${s}`], contributor),
            ));
      if (target) anchors.push({ wordId, el: target });
    }
    // Proposed sentence values (a translation) are stops too, keyed by their
    // cell so the sweep can tell where it is.
    for (const el of this.container.querySelectorAll(
      reviewSelector([(s) => `textarea.igt-field--sentence.igt-field--${s}`], contributor),
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
  },

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
  },

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
  },

  // The auto-linker leaves its suggestions as machine-unverified ("inferred")
  // violet chips. These turn reviewing them into a keyboard sweep, independent
  // of the cell grid (chips are buttons, not .igt-field cells, so _navMove never
  // reaches them): Ctrl/Cmd+Arrow hops chip-to-chip, Enter confirms, Backspace/
  // Delete removes, each advancing to the next — Space/click still opens the
  // popover to change the link.

  // Inferred, actionable chips in DOM (= reading) order.
  _inferredChips() {
    // Word and morpheme chips, and the labels of auto-linked multi-word
    // expressions, in document order.
    return [
      ...this.container.querySelectorAll(
        reviewSelector(
          [
            (s) => `button.igt-vocab__hint--${s}:not([disabled])`,
            (s) => `.igt-mwe__label--${s}:not([disabled])`,
          ],
          this.doc.isContributor,
        ),
      ),
    ];
  },

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
  },

  _predictionKeydown(e) {
    // Escape closes the floating menus (rows, copy format) and the popover.
    // Handled at the container, above the read-only guard: the opener keeps
    // focus, and all three work in a read-only view. No preventDefault — a
    // cell edit's own Escape has already reverted it by the time this bubbles
    // up.
    //
    // The popover needs this because it is not always FOCUSED: the vocab one
    // autofocuses its search box, whose keydown handles Escape and stops
    // propagation, but the comment one has no autofocus target, so focus stays
    // on the badge that opened it and the popover's own Escape handler never
    // sees the key. Closing here matches the outside click that already closes
    // all three (_onDocClick).
    if (e.key === 'Escape') {
      this._closeRowMenu();
      this._closeCopyMenu();
      const hadPopover = !!this._popover;
      // Keyboard-driven, so focus goes back to the opener.
      this._closePopover(true);
      // With no popover to close, Escape drops the words gathered for a
      // multi-word expression (a second Escape, when the popover was open).
      if (!hadPopover) this._clearMweSelection();
    }
    if (this.readOnly) return;
    // Gathering words for a multi-word expression from a chip or a bracket
    // label. A cell runs the same keys through its own handler first.
    if (!e.igtMweSeen && this._mweKeydown(e)) return;
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
    const isChip = !!el?.classList && this._isReviewable(el, 'igt-vocab__hint');
    // The label of an auto-linked multi-word expression reviews the same way.
    const isMweLabel = !!el?.classList && this._isReviewable(el, 'igt-mwe__label');
    if (!isChip && !isMweLabel) return;
    const tokenId = el.dataset.vocabOpener;
    if (!tokenId) return;
    const mweLinkId = isMweLabel ? tokenId.slice('mwe:'.length) : null;
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
      // One link, so the pulse is on that link, and focus hops to the next
      // chip as before. Backspace below removes rather than confirms, and a
      // removal is its own announcement: the chip is simply gone.
      this._pulseLink(tokenId);
      this._reviewLink(() =>
        mweLinkId ? this.doc.confirmMweLink(mweLinkId) : this.doc.confirmVocabLink(tokenId),
      );
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      this._reviewLink(() =>
        mweLinkId ? this.doc.unlinkMwe(mweLinkId) : this.doc.unlinkVocab(tokenId),
      );
    }
  },

  // Confirm/remove the focused suggestion, then advance to the next one —
  // captured BEFORE the mutation so the re-render lands focus on it. Confirming/
  // removing one token doesn't touch sibling chips, so the synchronous focus
  // usually survives lit's re-render; _restorePendingFocus re-affirms it.
  _reviewLink(mutate) {
    const next = this._adjacentChip('next');
    if (!next) {
      this._run(mutate);
      return;
    }
    this._runThenFocus({ vocabOpener: next.dataset.vocabOpener }, mutate);
    next.focus();
  },
};

// See the note at the end of IgtEditor.js: an island's live instance keeps
// its old prototype, so a change here forces a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
