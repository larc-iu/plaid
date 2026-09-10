import { splitChainText } from '@/domain/affixMarkers';
import { composeAppend, composePending } from '@/domain/compose';
import { ZERO_MORPH } from '@/domain/zeroMorph';
import { activeComposeTable, composePendingOn } from '@/lib/composeInput';
import { morphFormOf } from './shared.js';

// The morpheme form field: split, merge, and delete from the keyboard, paste
// that splits, and the commit of a form.
export const morphForm = {
  _morphFormKeydown(morph, word, siblings) {
    return async (e) => {
      // While a split is in flight the destination cell doesn't exist yet, but
      // the (still-focused, not-disabled) source input keeps receiving keys.
      // Buffer them and replay into the new morpheme once it renders, so fast
      // typing ("ngo-ko") never drops characters (review: split key-drop).
      if (this._morphSplit) {
        if (this._composing(e)) return;
        e.preventDefault();
        const st = this._morphSplit;
        const lastSplit = st.splits?.[st.splits.length - 1];
        // A backslash code half-typed into the buffer: `-` and `=` belong to
        // the code (`\i-` is ɨ, `\-5` is ˥), not to a new boundary.
        const midCode = composePending(st.buffer, st.buffer.length, { escapedAt: st.escapedAt });
        if (e.key === 'Enter' || e.key === 'Tab') st.commitKey = e.key;
        else if (e.key === 'Backspace') {
          // Takes back whatever was typed last: a boundary if one sits at the
          // end of the buffer, else a character.
          if (lastSplit && lastSplit.at === st.buffer.length) st.splits.pop();
          else st.buffer = st.buffer.slice(0, -1);
        } else if (
          (e.key === '-' || e.key === '=') &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey &&
          !midCode
        ) {
          // A further split typed mid-flight ("ngo-ko-mi" fast): remember the
          // boundary (and whether it was a clitic one) instead of inserting a
          // literal, and replay it as another split once the new cell exists.
          st.splits = [...(st.splits || []), { at: st.buffer.length, joiner: e.key }];
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // Composed as it goes, never in one pass at replay: `st.splits` holds
          // offsets into this buffer, and a late pass would move the text out
          // from under them.
          const next = composeAppend(st.buffer, e.key, {
            escapedAt: st.escapedAt,
            table: activeComposeTable(),
          });
          st.buffer = next.value;
          st.escapedAt = next.escapedAt;
        }
        // Arrows / Escape / etc. mid-flight are swallowed (no meaningful target).
        return;
      }
      if (this._composing(e)) return;
      if (this._mweKeydown(e)) return;
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

      // Alt+0 types the zero morph. It sits with Alt+- and Alt+= because it is
      // the same gesture (Alt inserts a character this cell would otherwise
      // read as a command), and it earns a chord of its own rather than only
      // the `\0/` code because a zero is roughly one morpheme in eight in real
      // data, common enough that a student meets it on their first text.
      if (e.key === '0' && e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this._insertLiteral(el, ZERO_MORPH);
        return;
      }
      // "-" splits at an affix boundary, "=" at a clitic boundary (the clitic
      // side is typed by the shared positional rule, see affixMarkers.js).
      // Ctrl/Cmd+- and Ctrl/Cmd+= are the browser's zoom keys: leave them.
      // A half-typed backslash code owns these keys first: 22 codes END in one
      // (`\i-` ɨ, `\l-` ɬ, `\u-` ʉ) and 18 BEGIN with one (the `\-5`..`\-1`
      // tone bars). Falling through lets beforeinput compose them.
      if ((e.key === '-' || e.key === '=') && !e.ctrlKey && !e.metaKey && !composePendingOn(el)) {
        const joiner = e.key;
        if (e.altKey) {
          // Alt+- / Alt+= inserts the literal character (reduplication forms,
          // forms that contain a hyphen) rather than splitting the morpheme.
          e.preventDefault();
          this._insertLiteral(el, joiner);
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
          escapedAt: -1,
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
        // The left-hand form is stored now, so it is what this cell was
        // "focused with": the render that just ran cleared the commit
        // suppression (it clears every stale flag), and without this the blur
        // that follows wrote the left-hand form a second time.
        el.dataset.orig = el.value;
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
  },

  // Flush keystrokes buffered while a split was in flight into the freshly
  // rendered + focused new morpheme cell, then honor a buffered commit key.
  // The morpheme id behind a form cell (`data-cell-key="mf:<id>"`).
  _morphIdOf(el) {
    const key = el?.dataset?.cellKey ?? '';
    return key.startsWith('mf:') ? key.slice(3) : null;
  },

  // `split` describes the cell the buffer belongs in: `left` and `right` are
  // the text around the caret as stored ('' and the split's right-hand form
  // for a fresh split), `buffer` the characters typed since, `splits` the
  // boundaries typed among them (offsets into `buffer`), `commitKey` an
  // Enter/Tab typed last.
  async _applyMorphSplitReplay(split) {
    if (!split) return;
    const el = this.container.querySelector(
      `.igt-morph-field[data-word="${split.wordId}"][data-prec="${split.precedence}"]`,
    );
    if (!el) return; // new cell didn't render as expected — nothing to replay into
    el.focus(); // stamps dataset.orig with the stored form, for the commit
    const left = split.left || '';
    const right = split.right || '';
    const buffer = split.buffer || '';
    // Built from the split's own pieces rather than read off the cell, and
    // typed into place: buffered characters went in at the caret.
    const text = left + buffer + right;
    const caret = left.length + buffer.length;
    if (el.value !== text) {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    try {
      el.setSelectionRange(caret, caret);
    } catch {
      /* not selectable */
    }
    // Further boundaries typed during the flight: split this cell again at
    // those positions (a real split each, never a literal; a "=" cut keeps
    // its clitic meaning). Keys typed while THAT split is in flight are
    // buffered again, against the last new piece, and replayed the same way,
    // so "ngo-ko-mi-ta" typed in one burst lands piece by piece however slow
    // the server is.
    const byCut = new Map();
    for (const { at, joiner } of split.splits || []) {
      const abs = left.length + at;
      if (abs > 0 && abs < text.length && !byCut.has(abs)) byCut.set(abs, joiner);
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
      const lastCut = cuts[cuts.length - 1];
      const lastSeg = segments[segments.length - 1];
      const caretInLast = Math.max(0, Math.min(lastSeg.length, caret - lastCut));
      // This cell keeps the first segment. Show that now, so the blur that
      // moving on causes has nothing else to write (the render clears the
      // suppression flag; `orig` is realigned below once the split is stored).
      el.value = segments[0];
      el.dataset.suppressCommit = '1';
      this._morphSplit = {
        buffer: '',
        escapedAt: -1,
        commitKey: split.commitKey,
        splits: [],
        left: lastSeg.slice(0, caretInLast),
        right: lastSeg.slice(caretInLast),
        wordId: split.wordId,
        precedence: split.precedence + segments.length - 1,
      };
      const ok = await this._run(() => this.doc.splitMorphemeMulti(morphId, segments, { joiners }));
      const chained = this._morphSplit;
      this._morphSplit = null;
      if (!ok) {
        el.value = text;
        delete el.dataset.suppressCommit;
        el.focus();
        return;
      }
      el.dataset.orig = el.value;
      await this._applyMorphSplitReplay(chained);
      return;
    }
    // A buffered Enter/Tab commits the new cell and advances (blur → commit).
    if (split.commitKey === 'Enter') {
      if (!this._navMove(el, 'next')) el.blur();
    } else if (split.commitKey === 'Tab') {
      this._navMove(el, 'next');
    }
  },

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
        return;
      }
      // The first segment is stored; realign the baseline so a late blur of
      // this cell (the render cleared its suppression flag) writes nothing.
      el.dataset.orig = el.value;
    };
  },

  _commitMorphForm(e, morphId) {
    if (this.readOnly) return;
    const el = e.target;
    if (el.dataset.suppressCommit) {
      delete el.dataset.suppressCommit;
      return;
    }
    const next = el.value;
    this._syncCellClasses(el, next);
    if (next === (el.dataset.orig ?? '')) return;
    this._runKeepingFocus(el, next, () => this.doc.updateMorphemeForm(morphId, next));
  },
};

// See the note at the end of IgtEditor.js: an island's live instance keeps
// its old prototype, so a change here forces a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
