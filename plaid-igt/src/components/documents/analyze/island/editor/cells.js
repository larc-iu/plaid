import { PROV } from '@larc-iu/plaid-client';
import { listAlternatives } from '@/domain/glossGuess';
import {
  isValueAllowed,
  partAtCaret,
  readTagsetName,
  resolveTagset,
  tagsetEnforces,
  validateValue,
} from '@/domain/tagsets';
import { readFieldLang, readVocabFields } from '@/domain/igtConfig';
import { notifyError, notifyInfo } from '@/utils/feedback';
import { arrowStep, caretAtArrowEdge } from '@ui/lib/bidi.js';
import { isImeKey } from '@ui/lib/chords.js';
import { keys } from '@/lib/keymap.js';
import { namesPendingId, settleKey } from '@ui/domain/pendingIds.js';
import { cellByKey, morphFormOf, sameCell } from './shared.js';
import { readCell } from './cellReader.js';

// An annotation cell's life: focus, typing, commit, the keyboard chords that
// move between cells, and the sentence fields' own handlers.

export const cells = {
  // Escape in a cell with nothing typed in it leaves the cell, as always, and
  // the next Tab (or Shift+Tab) then leaves the grid: Tab inside it walks every
  // cell of the document, so this is the keyboard's way past it. Any other key,
  // a click or focus going anywhere takes it back.
  _escapeCell(e, reset) {
    const el = e.target;
    // An Escape that let a conflict note go did that and only that.
    const clean = el.value === (el.dataset.orig ?? '') && !e.igtNoteDismissed;
    el.value = el.dataset.orig ?? '';
    reset?.(el);
    el.blur();
    if (clean) this._armGridExit();
  },

  _armGridExit() {
    this._gridExitOff?.();
    const doc = this.container.ownerDocument;
    const off = () => {
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('focusin', off, true);
      doc.removeEventListener('pointerdown', off, true);
      if (this._gridExitOff === off) this._gridExitOff = null;
    };
    const onKey = (e) => {
      // Shift, on its way to Shift+Tab, is not another key.
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      off();
      if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = this._pastGrid(e.shiftKey);
      if (!target) return;
      e.preventDefault();
      target.focus();
    };
    this._gridExitOff = off;
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('focusin', off, true);
    doc.addEventListener('pointerdown', off, true);
  },

  // The first Tab stop after the grid's sentences, or the last one before them.
  // With nothing on that side the page wraps round, as the browser's Tab does.
  _pastGrid(back) {
    const sentences = this.container.querySelectorAll('.igt-sentence');
    if (!sentences.length) return null;
    const edge = back ? sentences[0] : sentences[sentences.length - 1];
    const doc = this.container.ownerDocument;
    const all = [
      ...doc.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]',
      ),
    ].filter(
      (el) =>
        el.tabIndex >= 0 &&
        !el.closest('.igt-sentence') &&
        !el.closest('[hidden], [aria-hidden="true"]') &&
        el.getClientRects().length > 0,
    );
    const side = back ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
    const stops = all.filter((el) => edge.compareDocumentPosition(el) & side);
    const list = stops.length ? stops : all;
    return (back ? list[list.length - 1] : list[0]) ?? null;
  },

  _onFieldFocus(e) {
    this._rememberForTokenize(e.target);
    this._stampOrig(e.target);
    e.target.igtPick = null; // a pick belongs to the edit it was made in
    try {
      e.target.select();
    } catch {
      /* noop */
    }
    // A tagset-governed cell shows its list on focus rather than waiting for
    // Alt+Down: the tagset IS the set of legal values, so a picker that has to
    // be discovered leaves a closed field looking broken until you guess the
    // chord. Cells without one keep the Alt+Down affordance, since their list
    // is a suggestion rather than the rules.
    //
    // Except right after a mouse pick, which refocuses the same cell: the user
    // just chose from the list, and reopening it over the value they chose
    // reads as the pick not having taken.
    if (e.target.dataset.hasTagset && !this._skipAltsOnFocus) this._openAlts(e.target);
    this._skipAltsOnFocus = false;
  },

  // What a cell's edit is measured against from here on: the value it was
  // focused with, or for a value put back unsent (the cell engine) the stored
  // value under it, so that leaving the cell sends it again and Escape takes
  // it back. Focus takes the value up, so it is no longer waiting: the mark
  // goes now, and the next render agrees.
  _stampOrig(el) {
    const taken = this._cells.focus(el.dataset.cellKey);
    el.dataset.orig = taken ? taken.saved : el.value;
    if (taken) el.classList.remove('igt-field--unsent');
    // Which cell the edit is made in. A commit goes to whatever the input is
    // bound to when it leaves, so a render that reuses the input for another
    // row's cell has to know (uncontrolledValue in shared.js).
    el.igtFocusKey = el.dataset.cellKey;
  },

  // Morpheme form fields must NOT select-all on focus: the split handler reads
  // the caret position, and a select-all would make a stray '-' split at offset
  // 0 (empty left morpheme) — review M3. Just record the pristine value.
  _onMorphFormFocus(e) {
    this._stampOrig(e.target);
    // Select, like an annotation cell does. A morpheme cell starts out holding
    // the whole word and the entire job is retyping it segmented, so landing a
    // caret inside the value means the next keystroke corrupts it: clicking
    // mid-way into `Eve` and typing `ev-e` stored `Eev` + `eve` as the
    // morphemes of `Eve`, saved without complaint.
    try {
      e.target.select();
    } catch {
      /* not selectable */
    }
  },

  // A click into an unfocused cell must REPLACE its value, not caret into it.
  // The `select()` in the two focus handlers above is correct, and the browser
  // then undoes it: focus fires during mousedown, and mousedown's own default
  // action places the caret and collapses the selection. Keyboard navigation
  // produces no mouseup, which is why Tab and Enter always selected (via
  // _navMove) and only the mouse did not. So re-select on the mouseup that
  // completes the focusing click.
  //
  // Single-line cells only. A sentence textarea holds a free translation
  // someone edits one word of, where select-all-on-click would be wrong.
  _onCellMouseDown(e) {
    // A property, not an attribute: lit owns this element's attributes.
    e.currentTarget.igtFocusClick = document.activeElement !== e.currentTarget;
  },

  _onCellMouseUp(e) {
    const el = e.currentTarget;
    if (!el.igtFocusClick) return;
    el.igtFocusClick = false;
    // A drag that selected a range was deliberate. Leave it alone.
    if (el.selectionStart !== el.selectionEnd) return;
    try {
      el.select();
    } catch {
      /* not selectable */
    }
  },

  _onFieldInput(e) {
    const filled = e.target.value !== '';
    e.target.classList.toggle('igt-field--filled', filled);
    e.target.classList.toggle('igt-field--empty', !filled);
    // Typing while the alternatives list is open narrows it by prefix. On a
    // governed cell typing also REOPENS a closed list: a part-mode pick closes
    // it, and the next keystroke is usually the delimiter that starts the next
    // part, which wants the list back without an Alt+Down. Only a person's
    // keystroke does this — the input events the editor fires itself after a
    // pick or a guess adoption (see _syncInput) must not reopen what the pick
    // just closed.
    const key = e.target.dataset.cellKey;
    const synthetic = this._syntheticInput;
    this._syntheticInput = false;
    // Typing another value lets a lost conflict's value go (conflicts.js).
    if (!synthetic) this._cells.dismiss(key);
    const open = !!this._alts && this._alts.cellKey === key;
    if (!synthetic && !open && e.target.dataset.hasTagset) this._openAlts(e.target);
    if (this._alts && this._alts.cellKey === key) {
      this._alts.filter = this._filterTextFor(e.target);
      this._alts.active = 0;
      this._renderAlts();
    }
  },

  // Fire an input event for a value the editor set itself, so the cell's
  // filled/empty classes and the open list catch up, without it counting as
  // typing (see _onFieldInput).
  _syncInput(el) {
    this._syntheticInput = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    this._syntheticInput = false;
  },

  // What an open list filters on: the whole cell, or — when the field's tagset
  // splits composite values — just the part the caret is in, since that is the
  // part a pick will replace. Typing the second half of "1SG.NO" must narrow to
  // NOM, not to nothing.
  _filterTextFor(el) {
    const delims = el.dataset.tagsetDelims || '';
    if (!delims) return el.value;
    return (partAtCaret(el.value, el.selectionStart, delims)?.text ?? '').trim();
  },

  // While an IME composition is open, Enter picks a candidate, Escape cancels
  // it and Tab may convert: none of them is the editor's until it closes.
  _composing(e) {
    return isImeKey(e);
  },

  _basicKeydown(e) {
    if (this._composing(e)) return;
    this._conflictKeys(e);
    if (this._mweKeydown(e)) return;
    if (this._altsKeydown(e)) return;
    if (this._maybeConfirmWord(e)) return;
    if (this._maybeDiscardWord(e)) return;
    // The review sweep's chords belong to the container listener: leave them
    // alone so the hop wins over cell navigation.
    if (this._isSweepChord(e)) return;
    if (this._maybeArrowOutOfCell(e)) return;
    // Plain Enter is the ONE key that adopts a guess (user decision
    // 2026-08-26, reaffirmed 2026-09-13). Shift+Enter is a step backwards, and
    // nobody backing out of a cell means to commit what it shows; in FLEx the
    // same chord is "move on without approving", so a hand trained there was
    // writing guesses it meant to skip.
    if (e.key === 'Enter' && !e.shiftKey) this._maybeConfirmGuess(e.target);
    if (e.key === 'Enter') {
      // Commit and advance to the next cell in the same tier (the "fill a row
      // across" glossing workflow). Shift+Enter goes back, adopting nothing.
      // Falls back to blur (which commits) when there's no next cell.
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
      this._escapeCell(e);
    } else if (e.key === 'ArrowDown') {
      if (this._navMove(e.target, 'down')) e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      if (this._navMove(e.target, 'up')) e.preventDefault();
    }
  },

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
    // The two directions in one keystroke: the CELL's says whether the caret is
    // at the edge this key presses towards, the GRID's says which neighbour
    // that is. See @ui/lib/bidi.js.
    const visualRight = e.key === 'ArrowRight';
    if (!caretAtArrowEdge(el, visualRight)) return false;
    const step = arrowStep(visualRight, this._gridRtl());
    if (!this._navMove(el, step > 0 ? 'next' : 'prev')) return false;
    e.preventDefault();
    return true;
  },

  /** Is the grid laid out right to left? See @ui/domain/textDirection.js. */
  _gridRtl() {
    return this.doc?.textDirection === 'rtl';
  },

  // All focusable editable cells in DOM order (disabled inputs are excluded —
  // they aren't navigation targets).
  _navFields() {
    return [...this.container.querySelectorAll('.igt-field')].filter((el) => !el.disabled);
  },

  // The "tier" of a cell — its kind + field name ("wa:Gloss", "mf:"). Cells on
  // the same tier are the same logical row even when band wrapping puts them at
  // different screen rows. Rendered onto the cell (see cellTier), never read
  // back out of the key.
  _tierOf(el) {
    return el.dataset?.tier ?? '';
  },

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
    // 'next' and 'prev' are READING order, which is what Enter and Tab mean by
    // them. Screen x runs the other way in an RTL grid, so every horizontal
    // comparison below goes through `ahead`: positive means later in the
    // sentence, whichever way the words are laid out.
    const sign = this._gridRtl() ? -1 : 1;
    const ahead = (ex) => sign * (ex - cx);
    const rowTol = 12; // same-row band
    const colTol = 64; // same-column band
    const fields = this._navFields();
    const tier = this._tierOf(current);
    const vertical = dir === 'down' || dir === 'up';

    // A RUN of vertical moves keeps the column it started in. Without an
    // anchor a wide cell swallows the column on the way in and hands back a
    // different one on the way out, so ↓ then ↑ does not return where it
    // started. The run ends at any horizontal move, and at a focus that
    // arrives by some other route (a click, the review sweep), since the
    // anchor then no longer points at the cell being left.
    if (!vertical || this._navAnchor?.el !== current) this._navAnchor = null;
    const ax = this._navAnchor?.x ?? cx;

    // Same column band: horizontal extents overlap, or centres are close.
    // Overlap is what lets a WIDE cell see the narrow cells it spans. On
    // centres alone a sentence-scope field's only neighbour is the next
    // sentence's one — its centre sits half a sentence away from every word
    // column — so ↑ out of a translation skipped that sentence's word and
    // morpheme rows entirely.
    const inBand = (r, ex) =>
      (r.right > cr.left + 1 && r.left < cr.right - 1) || Math.abs(ex - ax) <= colTol;

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

    // Vertical: the NEAREST ROW in that direction wins outright, and only
    // then does the column decide which cell of it. Scoring the two together
    // let a far row with a well-aligned cell beat the row directly above or
    // below, which is what makes a vertical run unpredictable. `banded`
    // false is the fallback for a column with nothing left in it.
    const pickRow = (banded) => {
      const cands = [];
      for (const el of fields) {
        if (el === current) continue;
        const r = el.getBoundingClientRect();
        const ex = r.left + r.width / 2;
        const ey = r.top + r.height / 2;
        const dy = dir === 'down' ? ey - cy : cy - ey;
        if (dy <= 1) continue;
        if (banded && !inBand(r, ex)) continue;
        cands.push({ el, dy, dx: Math.abs(ex - ax) });
      }
      if (!cands.length) return null;
      const nearest = Math.min(...cands.map((c) => c.dy));
      // Cells of one row are not pixel-aligned (a morpheme chip and a word
      // cell differ in height), so the row is a band, not an exact dy.
      return cands.filter((c) => c.dy <= nearest + rowTol).reduce((a, b) => (b.dx < a.dx ? b : a))
        .el;
    };

    // Pass 1: strictly within the current screen row / column band.
    let best = vertical
      ? pickRow(true)
      : pick((el, ex, ey) => {
          if (Math.abs(ey - cy) > rowTol) return null;
          const d = ahead(ex);
          if (dir === 'next') return d > 1 ? d : null;
          return d < -1 ? -d : null;
        });

    // Pass 2: cross the band boundary.
    if (!best && !vertical) {
      // Same tier in a following/preceding band: nearest row in that
      // direction, then the leftmost (next) / rightmost (prev) cell in it.
      best = pick((el, ex, ey) => {
        if (this._tierOf(el) !== tier) return null;
        // Within the next band, the cell EARLIEST in reading order wins; within
        // the previous band, the latest. `sign * ex` orders them either way,
        // and the band term is four orders of magnitude larger, so it decides
        // first whatever the x coordinates are.
        if (dir === 'next') return ey > cy + rowTol ? (ey - cy) * 10000 + sign * ex : null;
        return ey < cy - rowTol ? (cy - ey) * 10000 + (10000 - sign * ex) : null;
      });
    }
    if (!best && vertical) best = pickRow(false);

    if (!best) return false;
    this._navAnchor = vertical ? { el: best, x: ax } : null;
    best.focus();
    try {
      best.select();
    } catch {
      /* not selectable */
    }
    return true;
  },

  // Commit an annotation/orthography cell on blur if its value changed. Routed
  // through the op chain so it serializes with structural edits. A value
  // adopted from a guess (see _maybeConfirmGuess) carries a born-verified
  // provenance fragment recording the guessed value (provDetail.value, so
  // adoptions per guess source stay countable); a typed value carries none
  // (apply(value, null)).
  _commitField(e, apply, tagset = null) {
    const el = e.target;
    // Leaving the cell: what focus took up is the input's own now (cell engine).
    this._cells.leave(el.igtFocusKey ?? el.dataset.cellKey);
    if (this.readOnly) return;
    this._closeAlts(); // leaving the cell dismisses its alternatives list
    if (el.dataset.suppressCommit) {
      delete el.dataset.suppressCommit;
      return;
    }
    if (!this._stillFocusedCell(el)) return;
    const next = el.value;
    this._syncCellClasses(el, next, tagset);
    // An enforcing tagset refuses a value it does not allow, here before any
    // request (core refuses a closed list's too, and mixed is this app's own).
    //
    // Refuse the way a failed save refuses (see _runKeepingFocus): keep what
    // was typed in the cell and put focus back, rather than reverting. The
    // value is wrong, but it is the user's, and silently swallowing a gloss
    // someone just typed is worse than leaving it there to be fixed.
    if (
      tagsetEnforces(tagset) &&
      next !== (el.dataset.orig ?? '') &&
      !isValueAllowed(next, tagset)
    ) {
      notifyError(
        `${this._violationText(validateValue(next, tagset), tagset)}. Escape to put the saved value back`,
        'Value not allowed',
      );
      // Nothing re-renders after a refusal; the class sync above has already
      // squiggled the cell, so it cannot read as committed. The next commit's
      // sync takes the squiggle off again once the text is a legal value.
      // Refocusing synchronously inside a blur handler is unreliable, so hand
      // it to a microtask. The focus handler restamps `orig` from whatever is
      // in the cell, which is the refused text — so put the SAVED value back
      // as `orig` afterwards. It is what Escape must revert to, and the
      // yardstick a corrected value is measured against. (With the refused
      // text as the baseline, every later Tab was a silent no-op that left an
      // unsaved value on screen, and Escape "reverted" to the very value that
      // had just been refused.) Leaving again with the same text is refused
      // again, out loud: each attempt gets its answer.
      const orig = el.dataset.orig ?? '';
      queueMicrotask(() => {
        el.focus();
        el.value = next;
        el.dataset.orig = orig;
      });
      return;
    }
    // What the value was taken from, if it was taken rather than typed: the
    // placeholder guess adopted with Enter, or a row picked from the list.
    const pick = el.igtPick ?? null;
    el.igtPick = null;
    const adopted =
      el.dataset.guessConfirmed === '1' && next === el.dataset.guessValue
        ? { value: next, source: el.dataset.guessSource || 'unknown' }
        : pick && pick.value === next
          ? pick
          : null;
    delete el.dataset.guessConfirmed;
    if (next === (el.dataset.orig ?? '')) return;
    // What this write says about a guess the cell showed, recorded once the
    // write lands (a refused save is no answer).
    const answer = this._guessAnswer(el, next);
    // Born-verified provenance is for a NEW span made from a suggestion. Over
    // a stored value a pick is a correction of that value, and the span keeps
    // its own history: the domain layer verifies a machine span on any human
    // edit, and a human span stays human. (Stamping the pick's fragment over a
    // model's span replaced provSource and provDetail with the picker's while
    // provProb kept the model's number — a span that said "precedent, 80% sure".)
    const fragment =
      adopted && (el.dataset.orig ?? '') === ''
        ? this.doc.adoptStamp(adopted.source, { value: next })
        : null;
    this._runKeepingFocus(el, next, () =>
      this._recordWhenSaved(apply(next, fragment), answer ? [answer] : []),
    );
  },

  // What History calls a cell edit: the field, what it belongs to, the
  // sentence and the value written ("Gloss of "dogs" in sentence 3: DOG").
  // `subject` is null for a sentence's own field, and `index` the sentence's
  // place in the document, counted from 0.
  _editLabel(field, subject, index, value) {
    return this._labelFor(this._cellWhat(field, subject, index), value);
  },

  // The label of an edit of the cell `what` names that writes `value`.
  _labelFor(what, value) {
    const chars = [...(value ?? '')];
    const shown = chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : chars.join('');
    return shown ? `${what}: ${shown}` : `${what} cleared`;
  },

  // The cell itself, as History and the leave question name it: "Gloss of
  // "dogs" in sentence 3".
  _cellWhat(field, subject, index) {
    const sentence = index == null ? '' : `sentence ${index + 1}`;
    return subject
      ? `${field} of ${subject}${sentence ? ` in ${sentence}` : ''}`
      : `${field}${sentence ? ` of ${sentence}` : ''}`;
  },

  // A morpheme as History names it: by its form, within its word when the
  // word has more than one, and by its place when it has no form yet.
  _morphemeSubject(morph, word, siblings) {
    const form = morphFormOf(morph);
    if (siblings.length <= 1) return `morpheme "${form || word.content}"`;
    const which = form ? `"${form}"` : String(morph.precedence ?? siblings.indexOf(morph) + 1);
    return `morpheme ${which} of "${word.content}"`;
  },

  // Keep the classes this file toggles by hand in step with the cell's text.
  // lit only rewrites the class attribute when one of ITS interpolations
  // changes, so a class flipped by hand (the input handler's filled/empty, the
  // refusal squiggle) outlives the state it described until something else
  // moves — an Escape or a retype that lands on the saved value re-renders
  // nothing at all. Called on every commit, which is where a cell's text
  // settles; the result is exactly what a render of that text would paint.
  _syncCellClasses(el, value, tagset = null) {
    const filled = value !== '';
    el.classList.toggle('igt-field--filled', filled);
    el.classList.toggle('igt-field--empty', !filled);
    if (tagset) el.classList.toggle('igt-field--invalid', validateValue(value, tagset).length > 0);
  },

  // Run a cell commit. When it is refused (server unreachable, a conflict) the
  // document reads itself again and re-renders, and the cell engine decides
  // what the cell shows (plaid-ui cells/CellEngine.js): the typed value put
  // back to be sent again, the other user's value with this one under it, or
  // what is stored after a refusal that sending again cannot mend. A cell on
  // a page not drawn is decided the same way, and waits for its page.
  //
  // Put back into its cell, the value takes focus with it (E2: focus is never
  // lost) only when focus is still in this cell or dropped to the body. Focus
  // resting in another cell stays there, typed into or not: the person may be
  // typing into it the moment the refusal lands, and taking focus back sent
  // those letters after the refused value, into the refused cell ("DOG"
  // refused, "CHASE" typed in the next word, "DOGCHASE" stored on the first).
  // Taking focus from a cell with typed text also commits it, and two cells
  // whose saves keep failing would take focus from each other and resend
  // forever (plaid-ui domCells.js).
  //
  // A conflict is this cell's to report, so the document raises no toast of
  // its own for one (DocumentModel.cellWrite).
  _runKeepingFocus(el, typed, fn) {
    const key = el.dataset.cellKey;
    if (!key) {
      this.doc.cellWrite(fn);
      return;
    }
    const ticket = this._cells.sending(key, {
      // The stored value as of this commit: what Escape reverts to and what a
      // retry is measured against.
      saved: el.dataset.orig ?? '',
      typed,
      entityIds: el.igtEntityIds ?? [],
      field: (el.dataset.tier ?? '').split(':').slice(1).join(':') || 'morpheme form',
      // The leave question's name for the cell ("Gloss of "dogs" in sentence 3").
      what: el.igtWhat ?? null,
    });
    this.doc.cellWrite(fn, { engine: true }).then((outcome) => {
      if (!this._destroyed) this._cells.settle(ticket, outcome);
    });
  },

  // Text typed into a cell whose input a render has since reused for another
  // row's cell (`igtDisplaced`, set by uncontrolledValue in shared.js). Focus
  // leaves that input first, or the next keystroke would go onto the other
  // row. The text, and focus with it, goes back into the cell it was typed in
  // when that is still drawn, so typing goes on there. A cell made by an edit
  // the server refused is gone with it, and that refusal has said so.
  // Otherwise the row is gone: say what was lost.
  _rehomeDisplaced() {
    const el = document.activeElement;
    const d = el?.igtDisplaced;
    if (!d) return;
    el.igtDisplaced = null;
    this._syncCellClasses(el, el.value, el.igtTagset ?? null);
    el.blur();
    const key = settleKey(d.key);
    const home = cellByKey(this.container, key);
    if (home && home !== el) {
      const stored = readCell(this.doc, key) ?? '';
      if (stored !== d.saved) {
        this._cells.conflict(key, d.typed, stored);
        return;
      }
      // Focus first (the focus handler stamps dataset.orig from the stored
      // value), then the text, so leaving the cell sends it.
      home.focus();
      home.value = d.typed;
      home.dataset.orig = d.saved;
      home.setSelectionRange?.(d.typed.length, d.typed.length);
      this._syncCellClasses(home, d.typed, home.igtTagset ?? null);
      return;
    }
    if (namesPendingId(key)) return;
    notifyError(`Not saved: ${d.typed}`, 'Changed elsewhere');
  },

  // Whether a cell's input is still bound to the cell it was focused in. A
  // render that reuses it for another takes the typed text out first (see
  // uncontrolledValue), so this is the last line: a commit never goes to a
  // row the edit was not made in.
  _stillFocusedCell(el) {
    return el.igtFocusKey == null || sameCell(el.igtFocusKey, el.dataset.cellKey);
  },

  /**
   * A cell's alternatives list, memoized for the duration of one render pass.
   *
   * `_field` asks EVERY annotation cell for its list on EVERY render, to size
   * the caret affordance and the tooltip — 1,200 calls for a 300-word document.
   * That was tolerable while the list only opened on Alt+Down, and stopped
   * being so when a governed cell began opening it on FOCUS: every Tab across
   * the grid paid for a full recompute of the whole document.
   *
   * The result depends only on (kind, form, field, linked entry) once the
   * precedent tally is fixed, and a document repeats the same morpheme form
   * hundreds of times, so the hit rate is high. A cell whose span carries a
   * model prediction is per-cell by definition and skips the memo. The key
   * holds how the cell reads a gloss (readingTagset), since a stem's list and
   * an affix's of the same form keep different values under a mixed tagset.
   */
  _alternatives(args) {
    const detail = args.span?.metadata?.[PROV.detailKey];
    if (detail) return listAlternatives(args);
    const reading = JSON.stringify(args.tagset?.reading ?? null);
    const key = `${args.kind}\u0000${args.form}\u0000${args.field}\u0000${args.vocabItem?.id ?? ''}\u0000${reading}`;
    const memo = (this._altsMemo ||= new Map());
    let hit = memo.get(key);
    if (!hit) memo.set(key, (hit = listAlternatives(args)));
    return hit;
  },

  // Why a cell is flagged, for its tooltip and for the rejection toast. Named
  // parts, because "invalid value" tells a person nothing about which half of
  // 1SG.ABL to fix.
  _violationText(violations, tagset) {
    const unknown = violations.filter((x) => x.reason === 'unknown').map((x) => x.part);
    const bits = [];
    if (unknown.length) {
      const list = unknown.map((u) => `"${u}"`).join(', ');
      const verb = unknown.length === 1 ? 'is not' : 'are not';
      const where = tagset?.name ? `the ${tagset.name} tagset` : "this field's tagset";
      bits.push(`${list} ${verb} in ${where}`);
    }
    if (violations.some((x) => x.reason === 'empty')) {
      bits.push('There is a delimiter with nothing beside it');
    }
    return bits.join('. ');
  },

  _onSentenceInput(e) {
    this._onFieldInput(e);
    this._autoGrow(e.target);
  },

  // Enter commits (the value is logically one translation); Shift+Enter inserts
  // a newline; Tab hops to the same field in the next sentence (fill all
  // translations top to bottom), falling through to the default at the end;
  // Escape reverts.
  _sentenceKeydown(e) {
    if (this._composing(e)) return;
    this._conflictKeys(e);
    // The review sweep's chords belong to the container listener: leave them
    // alone so the hop wins over cell navigation.
    if (this._isSweepChord(e)) return;
    // An open picker gets first claim on ↑↓/↵/Esc, exactly as in a grid cell.
    // It is only ever open on a tagset-governed field, so a plain Translation
    // keeps every key it has today.
    if (this._altsKeydown(e)) return;
    // Ctrl/Cmd+Backspace: discard a proposed translation wholesale, the sentence
    // counterpart of the word gesture, then move to the next sentence's same
    // field so a sweep reads "accept, accept, discard, accept" down a document.
    // Claimed ONLY over an untouched machine-made value: everywhere else this
    // is the browser's delete-previous-word, which matters in a field that
    // holds prose rather than a one-word gloss.
    if (keys.is('analyze.discard', e)) {
      const el = e.target;
      const sid = el.dataset.confirmSentence;
      const field = el.dataset.fieldName;
      if (this.readOnly || !sid || !field) return;
      if (el.value !== (el.dataset.orig ?? '')) return;
      if (!this._isReviewable(el, 'igt-field')) return;
      e.preventDefault();
      // The DOM still holds the discarded text until the re-render: don't let
      // the blur from the hop write it back.
      el.dataset.suppressCommit = '1';
      this.doc.discardSentenceSpan(sid, field);
      if (!this._navMove(el, 'next')) el.blur();
      return;
    }
    if (keys.is('analyze.accept', e)) {
      // Ctrl+Enter: accept a machine-made value as is (the sentence
      // counterpart of the word gesture) and hop to the same field of the
      // next sentence. An edited value commits instead, which verifies it.
      // Like the word gesture, it holds position when there is nothing to
      // accept rather than hopping on a silent no-op.
      e.preventDefault();
      const el = e.target;
      const sid = el.dataset.confirmSentence;
      const field = el.dataset.fieldName;
      if (this.readOnly || !sid || !field) return;
      const unchanged = el.value === (el.dataset.orig ?? '');
      if (unchanged && !this._isReviewable(el, 'igt-field')) {
        notifyInfo(
          el.value
            ? 'This value was made by a person already.'
            : 'There is nothing proposed here yet.',
          `Nothing to accept in ${field}`,
        );
        return;
      }
      if (!unchanged) {
        // An edited value commits on the way out, which verifies it. That is
        // an edit, not an accept, and it wears the value it typed.
        if (!this._navMove(el, 'next')) el.blur();
        return;
      }
      if (this._refuseOffList([el], `Nothing accepted in ${field}`, el)) return;
      this.doc.confirmSentenceSpan(sid, field);
      // Same beat as the word gesture, and for a stronger reason: the hop is
      // to the NEXT SENTENCE, so without it the pulse plays on a row already
      // scrolled past.
      this._pulse(el.closest('.igt-sentence-anno'));
      this._afterABeat(() => {
        if (!this._navMove(el, 'next')) el.blur();
      });
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.target.blur();
    } else if (e.key === 'Tab') {
      if (this._navMove(e.target, e.shiftKey ? 'prev' : 'next')) e.preventDefault();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this._escapeCell(e, (el) => this._autoGrow(el));
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Leave the textarea only from its last/first line (caret at the very
      // end/start); inside a multi-line translation the arrows still move the
      // caret. Without this the Translation field trapped ArrowDown.
      const el = e.target;
      // Which edge the press collapses a selection to: ArrowDown to its end,
      // ArrowUp to its start. Testing the collapsed caret instead meant that
      // focusing a cell (which selects it) made the FIRST press in either
      // direction do nothing at all — one press swallowed per field crossed,
      // so the same number of ↑ and ↓ presses no longer came back level.
      const atEnd = el.selectionEnd === el.value.length;
      const atStart = el.selectionStart === 0;
      if ((e.key === 'ArrowDown' && atEnd) || (e.key === 'ArrowUp' && atStart)) {
        if (this._navMove(el, e.key === 'ArrowDown' ? 'down' : 'up')) e.preventDefault();
      }
    }
  },

  _autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  },

  // Type one character at the caret, replacing any selection, and let the
  // ordinary input path see it. Used by the Alt chords in a morpheme form cell.
  _insertLiteral(el, ch) {
    const s = el.selectionStart ?? el.value.length;
    const en = el.selectionEnd ?? s;
    el.value = el.value.slice(0, s) + ch + el.value.slice(en);
    const c = s + ch.length;
    try {
      el.setSelectionRange(c, c);
    } catch {
      /* noop */
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },

  // The gloss-guess source reads the precedent tally (project + this
  // document), which is itself memoized per data version and project fetch;
  // rebuild the source only when that tally object changes, so the many
  // non-data re-renders (popover open/keystroke, paging, help toggle…) reuse
  // it. Rebuilds if the pluggable factory is swapped (e.g. a service-backed
  // source).
  // The tagset governing a field, keyed by the layerInfo scope bucket and the
  // field name, or null when the field references none (or a name the project
  // no longer has — see resolveTagset). Memoized on the project object and
  // layerInfo, both stable between data changes, because this is asked once per
  // rendered cell.
  _tagsetFor(scope, name) {
    const project = this.doc.project;
    const info = this.doc.layerInfo;
    if (this._tagsetCacheProject !== project || this._tagsetCacheInfo !== info) {
      this._tagsetCacheProject = project;
      this._tagsetCacheInfo = info;
      const map = new Map();
      for (const [bucket, layers] of Object.entries(info?.spanLayers || {})) {
        for (const sl of layers || []) {
          const t = resolveTagset(sl.config, project?.config);
          // The name rides along so a rejection can say WHICH list refused the
          // value. Nothing in tagsets.js reads it.
          if (t) map.set(`${bucket}:${sl.name}`, { ...t, name: readTagsetName(sl.config) });
        }
      }
      this._tagsetCache = map;
    }
    return this._tagsetCache.get(`${scope}:${name}`) ?? null;
  },

  // What pairs an annotation field with a field of the linked lexicon entry
  // when their names differ (see entryFieldFor): the language the annotation
  // field records and the entry's field schema. Asked once per rendered cell,
  // so the languages are memoized on layerInfo like the tagsets above.
  _entryPairing(scope, name, vocabItem) {
    const info = this.doc.layerInfo;
    if (this._fieldLangCacheInfo !== info) {
      this._fieldLangCacheInfo = info;
      const map = new Map();
      for (const [bucket, layers] of Object.entries(info?.spanLayers || {})) {
        for (const sl of layers || []) map.set(`${bucket}:${sl.name}`, readFieldLang(sl.config));
      }
      this._fieldLangCache = map;
    }
    const vocab = vocabItem ? this.doc.vocabularies?.[vocabItem.vocabId] : null;
    return {
      fieldLang: this._fieldLangCache.get(`${scope}:${name}`) ?? null,
      entryFields: vocab ? readVocabFields(vocab.config) : null,
    };
  },

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
  },
};

// See the note at the end of IgtEditor.js: an island's live instance keeps
// its old prototype, so a change here forces a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
