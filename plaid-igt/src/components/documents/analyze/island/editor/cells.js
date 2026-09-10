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
import { notifyError, notifyInfo } from '@/utils/feedback';

// An annotation cell's life: focus, typing, commit, the keyboard chords that
// move between cells, and the sentence fields' own handlers.
export const cells = {
  _onFieldFocus(e) {
    this._rememberForTokenize(e.target);
    e.target.dataset.orig = e.target.value;
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

  // Morpheme form fields must NOT select-all on focus: the split handler reads
  // the caret position, and a select-all would make a stray '-' split at offset
  // 0 (empty left morpheme) — review M3. Just record the pristine value.
  _onMorphFormFocus(e) {
    e.target.dataset.orig = e.target.value;
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
  // Chrome reports such keys as keyCode 229 as well as isComposing.
  _composing(e) {
    return !!e.isComposing || e.keyCode === 229;
  },

  _basicKeydown(e) {
    if (this._composing(e)) return;
    if (this._mweKeydown(e)) return;
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
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (start !== end) return false;
    const atEdge = e.key === 'ArrowLeft' ? start === 0 : end === (el.value ?? '').length;
    if (!atEdge) return false;
    if (!this._navMove(el, e.key === 'ArrowLeft' ? 'prev' : 'next')) return false;
    e.preventDefault();
    return true;
  },

  // All focusable editable cells in DOM order (disabled inputs are excluded —
  // they aren't navigation targets).
  _navFields() {
    return [...this.container.querySelectorAll('.igt-field')].filter((el) => !el.disabled);
  },

  // The "tier" of a cell — its kind + field name from data-cell-key
  // (`wa:<id>:Gloss` -> "wa:Gloss"; `mf:<id>` -> "mf:"). Cells on the same
  // tier are the same logical row even when band wrapping puts them at
  // different screen rows.
  _tierOf(el) {
    const key = el.dataset?.cellKey ?? '';
    const parts = key.split(':');
    return `${parts[0]}:${parts.slice(2).join(':')}`;
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
          if (dir === 'next') return Math.abs(ey - cy) <= rowTol && ex > cx + 1 ? ex - cx : null;
          return Math.abs(ey - cy) <= rowTol && ex < cx - 1 ? cx - ex : null;
        });

    // Pass 2: cross the band boundary.
    if (!best && !vertical) {
      // Same tier in a following/preceding band: nearest row in that
      // direction, then the leftmost (next) / rightmost (prev) cell in it.
      best = pick((el, ex, ey) => {
        if (this._tierOf(el) !== tier) return null;
        if (dir === 'next') return ey > cy + rowTol ? (ey - cy) * 10000 + ex : null;
        return ey < cy - rowTol ? (cy - ey) * 10000 + (10000 - ex) : null;
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
    if (this.readOnly) return;
    const el = e.target;
    this._closeAlts(); // leaving the cell dismisses its alternatives list
    if (el.dataset.suppressCommit) {
      delete el.dataset.suppressCommit;
      return;
    }
    const next = el.value;
    this._syncCellClasses(el, next, tagset);
    // An enforcing tagset refuses a value it does not allow. Typing is the ONLY
    // write that passes through here, so this is the whole of what "closed"
    // enforces: imports, services and the assistant reach the same span layer
    // without coming this way, which is what the Validation view is for.
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
        `${this._violationText(validateValue(next, tagset), tagset)}. Escape puts the saved value back`,
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
    this._runKeepingFocus(el, next, () => apply(next, fragment));
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

  // Run a cell commit; when it FAILS (server unreachable, conflict…) the doc
  // reloads and re-renders, which used to drop focus to <body> and leave the
  // user to click back. Put the typed value back into the same cell and
  // refocus it so Enter retries (E2: focus is never lost).
  _runKeepingFocus(el, typed, fn) {
    const key = el.dataset.cellKey;
    // The stored value as of this commit: what Escape must revert to and what
    // a retry is measured against. Read now rather than after the failure,
    // when the cell may have been refocused (and restamped) in the meantime.
    const saved = el.dataset.orig ?? '';
    this._run(fn).then((ok) => {
      if (ok !== false || !key) return;
      const cell = this.container.querySelector(`[data-cell-key="${key}"]`);
      if (!cell) return;
      // Focus first (the focus handler stamps dataset.orig from whatever the
      // reload put in the cell), then restore what was typed over it.
      cell.focus();
      cell.value = typed;
      cell.dataset.orig = saved;
      this._syncCellClasses(cell, typed, cell.igtTagset ?? null);
    });
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
   * model prediction is per-cell by definition and skips the memo.
   */
  _alternatives(args) {
    const detail = args.span?.metadata?.[PROV.detailKey];
    if (detail) return listAlternatives(args);
    const key = `${args.kind}\u0000${args.form}\u0000${args.field}\u0000${args.vocabItem?.id ?? ''}`;
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
    // Ctrl/Cmd+Arrow is the review sweep's chord (container listener): leave
    // it alone so the chip hop wins over cell navigation.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) return;
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
    if ((e.key === 'Backspace' || e.key === 'Delete') && (e.ctrlKey || e.metaKey)) {
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
      this._run(() => this.doc.discardSentenceSpan(sid, field));
      if (!this._navMove(el, 'next')) el.blur();
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
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
      this._run(() => this.doc.confirmSentenceSpan(sid, field));
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
      e.target.value = e.target.dataset.orig ?? '';
      this._autoGrow(e.target);
      e.target.blur();
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
