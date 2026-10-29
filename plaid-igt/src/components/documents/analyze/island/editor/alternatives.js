import { render, html, nothing } from 'lit-html';
import { collationKey } from '@ui/domain/collation.js';
import { TAGSET_SOURCE } from '@/domain/glossGuess';
import { isValueAllowed, replacePartAtCaret } from '@/domain/tagsets';
import { anchoredPos, cellByKey } from './shared.js';
import { keys } from '@/lib/keymap.js';

// The alternatives list: Alt+Down on a cell lists every value the project
// has given that form, and a pick adopts one. On a morpheme's gloss the rows
// are the pair picker's (pairPicker.js), each a sense and a value, and a pick
// writes both.
export const alternatives = {
  // seen for the form (domain/glossGuess.js listAlternatives), ranked, with
  // its provenance. ↑↓ move, ↵ picks, Esc closes, typing narrows. A pick goes
  // through the guess-adoption path (data-guess-* + blur-commit), so it is
  // written born-verified with the row's source, exactly like adopting a
  // placeholder guess; the cell keeps focus.
  // `asked`: the person asked for the list (Alt+Down), as opposed to a
  // governed cell opening it on focus. Moving in a list asks for it too, and
  // typing in the cell takes it back (cells.js _onFieldInput), so Enter
  // commits what was typed. Enter and Escape read the difference.
  _openAlts(el, { asked = false } = {}) {
    const items = this._altsItems(el, '');
    if (!items.length) return;
    const active = this._altsStartRow(el, items);
    this._alts = { cellKey: el.dataset.cellKey, active, filter: '', visible: [], asked };
    this._altsPos = this._computeAltsPos(el, items.length);
    this._renderAlts();
  },

  // The row a list starts on: the one holding what the cell holds (on a pair
  // list the current pair, its gloss with its link or with none), so Enter
  // there leaves the cell as it was. Else a pair list starts where the
  // chip's does (pairPicker.js), and a value list on its first row.
  _altsStartRow(el, items) {
    const pair = !!items[0]?.pair;
    const own = items.findIndex((it) =>
      pair ? it.current && it.value === el.value : el.value !== '' && it.value === el.value,
    );
    if (own >= 0) return own;
    return pair ? this._pairDefaultRow(items) : 0;
  },

  _closeAlts() {
    if (!this._alts) return;
    this._alts = null;
    this._altsPos = null;
    this._renderAlts();
  },

  /**
   * Render just the popup. Everything that opens, filters, moves within or
   * closes the list comes here rather than to _render, because a full pass
   * rebuilds every cell in the document — ~1,200 of them for 300 words — and
   * a governed cell opens this on every focus, so that cost landed on every
   * Tab across the grid.
   */
  _renderAlts() {
    // The list has its own root, taken down with the island (see destroy).
    if (this._destroyed) return;
    const el = this._alts ? cellByKey(this.container, this._alts.cellKey) : null;
    const items =
      el && typeof el.igtAlts === 'function' ? this._altsItems(el, this._alts.filter) : null;
    render(
      this._alts && items ? this._altsTemplate(items, this._alts.cellKey) : nothing,
      this._altsRoot,
    );
  },

  // A cell's rows. A pair picker cell whose tagset splits values lists whole
  // pairs until something is typed, and then the parts, as any such cell does.
  _altsItems(el, filter) {
    const typed = filter || el.value !== (el.dataset.orig ?? el.value);
    if (typed && typeof el.igtPartAlts === 'function') return el.igtPartAlts();
    return typeof el.igtAlts === 'function' ? el.igtAlts() : [];
  },

  // What a pick of a pair row sets the cell to: its value, or for a row with
  // none what the cell holds.
  _pairValue(el, it) {
    return it.value !== '' ? it.value : el.value;
  },

  // Returns true when the key was handled by the list.
  _altsKeydown(e) {
    const el = e.target;
    const open = !!this._alts && this._alts.cellKey === el.dataset.cellKey;
    if (keys.is('analyze.alternatives', e)) {
      e.preventDefault();
      // On a list a governed cell opened by itself (a cell reached by Enter,
      // Shift+Enter or Tab), Alt+Down asks for it all the same.
      if (!open) this._openAlts(el, { asked: true });
      else this._alts.asked = true;
      return true;
    }
    if (!open) return false;
    // Ctrl/Cmd+Enter is the whole-word accept wherever it is pressed; the list
    // never takes it.
    // Any Ctrl/Cmd+Enter as well, whatever it is bound to now: with a modifier
    // held it is never "take the highlighted row".
    if (keys.is('analyze.accept', e) || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      this._closeAlts();
      return false;
    }
    const items = this._alts.visible || [];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length;
      if (n) {
        // From no row, ↓ lands on the first and ↑ on the last.
        const from =
          this._alts.active < 0 ? (e.key === 'ArrowDown' ? n - 1 : 0) : this._alts.active;
        this._alts.active = (from + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        // The person is now addressing the list, so Enter belongs to it.
        this._alts.asked = true;
        this._renderAlts();
      }
      return true;
    }
    if (e.key === 'Enter') {
      // Whose key is this, the list's or the cell's? A list the person asked
      // for (Alt+Down, or moved in) takes Enter on its highlighted row,
      // whatever it is (R55). A list a governed cell opened on focus hands
      // Enter back, since that Enter is the ordinary "commit and move on"
      // (it once replaced a stored PL with the form's most frequent gloss),
      // unless the person is completing: on an ENFORCING tagset they typed a
      // prefix that is not itself a legal value and a row matches it.
      //
      // A row that would write nothing (a pair row that changes neither
      // value nor link and confirms nothing, a value row the cell already
      // holds) hands Enter back too, and the cell commits as it is.
      const it = items.length && this._alts.active >= 0 ? items[this._alts.active] : null;
      const typed = this._alts.filter || '';
      const enforcing = el.dataset.tagsetEnforces === '1';
      const delims = el.dataset.tagsetDelims || '';
      const would = !it
        ? null
        : it.pair
          ? this._pairValue(el, it)
          : delims
            ? replacePartAtCaret(el.value, el.selectionStart, delims, it.value).value
            : it.value;
      const acts = !!it && (it.pair ? this._pairActs(it, el.value) : would !== el.value);
      const completing = typed !== '' && enforcing && !isValueAllowed(typed, el.igtTagset ?? null);
      if (!acts || !(this._alts.asked || completing)) {
        this._closeAlts();
        return false; // fall through to the normal commit path
      }
      e.preventDefault();
      this._pickAlt(el, it, { advance: true });
      return true;
    }
    if (e.key === 'Escape') {
      // The same question as Enter: is the list what the user is addressing?
      // A list that opened on its own and has not been typed into or moved
      // in is not, so Escape falls through and reverts the cell in one press,
      // as it does everywhere else. A list the person asked for is, and so
      // is one mid-completion: Escape closes the list, keeps what was typed,
      // and leaves the cell where it is.
      const engaged = !!this._alts.asked || (this._alts.filter || '') !== '';
      this._closeAlts();
      if (!engaged) return false;
      e.preventDefault();
      return true;
    }
    if (e.key === 'Tab') this._closeAlts();
    return false;
  },

  _pickAlt(el, item, { advance = false } = {}) {
    this._alts = null;
    this._altsPos = null;
    // Redraw the (now empty) list here, not downstream: the blur that follows
    // a whole-value pick finds the state already cleared and closes nothing,
    // which left the old rows on screen once the refocus stopped redrawing.
    this._renderAlts();
    // A pair row is a whole value and a link: the cell takes the value and the
    // commit writes both (_commitField hands the row to the cell's apply).
    const delims = item.pair ? '' : el.dataset.tagsetDelims || '';
    if (item.pair) {
      el.value = this._pairValue(el, item);
    } else if (delims) {
      // Part mode: the pick replaces only the part the caret is in, so
      // completing "1SG.NO" with NOM yields "1SG.NOM" and leaves the caret
      // after it, ready for the next delimiter.
      const { value, caret } = replacePartAtCaret(el.value, el.selectionStart, delims, item.value);
      el.value = value;
      try {
        el.setSelectionRange(caret, caret);
      } catch {
        /* not selectable */
      }
    } else {
      el.value = item.value;
    }
    // Provenance marks a machine suggestion a person confirmed. Two picks are
    // not that and carry none: one from the TAGSET (a list of legal values is
    // not a predictor, so choosing from it is an ordinary human edit), and any
    // pick in part mode (a composite assembled part by part is the user's
    // construction, and stamping the whole value as inferred would overclaim
    // what the source actually proposed).
    //
    // Carried as a plain property, NOT in the data-guess-* attributes: lit
    // owns those, and it only rewrites an attribute when it computes a value
    // different from the one it last wrote — so a value put there by hand
    // survives every later render that agrees with the previous one. A pick
    // parked there outlived its own commit, and Enter on the cell after it was
    // cleared "adopted" the stale pick straight back.
    if (item.pair) {
      el.igtPick = {
        value: el.value,
        source: item.source !== TAGSET_SOURCE ? item.source : null,
        pair: item,
      };
    } else if (item.source !== TAGSET_SOURCE && !delims) {
      // A model's alternative brings its probability, the value's provProb.
      el.igtPick = {
        value: item.value,
        source: item.source,
        ...(typeof item.prob === 'number' ? { prob: item.prob } : {}),
      };
    }
    this._syncInput(el);
    // Part mode keeps the caret in the cell: the value is mid-construction and
    // a blur-commit here would write a half-finished gloss and lose the caret.
    // The next Enter commits it (the list is closed now, so Enter is the
    // cell's again), and typing the next delimiter reopens the list.
    if (delims) {
      el.focus();
      return;
    }
    // Whole-value mode commits. From the keyboard it also MOVES ON, exactly as
    // Enter on a typed value does: the row was the answer for this cell, and
    // the next cell is where the work is. A mouse pick stays put, but without
    // reopening the list over the value that was just chosen.
    if (advance) {
      if (!this._navMove(el, 'next')) el.blur();
      return;
    }
    const key = el.dataset.cellKey;
    el.blur(); // commits via _commitField (born-verified) and re-renders
    const same = cellByKey(this.container, key);
    if (same) {
      this._skipAltsOnFocus = true;
      same.focus();
    }
  },

  _pickAltByKey(cellKey, item) {
    const el = cellByKey(this.container, cellKey);
    if (el) this._pickAlt(el, item);
  },

  // At least as wide as the cell it lists for, and as tall as its rows up to
  // the eight it scrolls past. Placed like every other floating surface.
  _computeAltsPos(el, n) {
    const width = Math.max(160, el?.getBoundingClientRect?.().width ?? 0);
    const pos = anchoredPos(el, { width, height: Math.min(n, 8) * 24 + 10, gap: 2 });
    return pos && { ...pos, width };
  },

  _repositionAlts() {
    if (!this._alts) return;
    const el = cellByKey(this.container, this._alts.cellKey);
    const list = this._altsRoot?.querySelector('.igt-alts');
    if (!el || !list) return;
    const pos = this._computeAltsPos(el, (this._alts.visible || []).length || 1);
    if (!pos) return;
    this._altsPos = pos;
    list.style.left = `${pos.left}px`;
    list.style.top = `${pos.top}px`;
  },

  _altsTemplate(items, cellKey) {
    const a = this._alts;
    // Either spelling narrows the list: `ẹ` can be one character or `e` plus a
    // combining dot, and which one a value carries depends on the keyboard or
    // the import it came from. Same key the search boxes compare through.
    const f = collationKey(a.filter || '');
    const visible = f ? items.filter((it) => collationKey(it.value).startsWith(f)) : items;
    a.visible = visible;
    // A typed filter starts on its first row, a list that started on none
    // included (pairPicker.js _pairDefaultRow).
    if (a.active >= visible.length || (a.active < 0 && f)) a.active = 0;
    const pos = this._altsPos;
    const posStyle = pos ? `left:${pos.left}px;top:${pos.top}px;min-width:${pos.width}px;` : '';
    const pairs = items.some((it) => it.pair);
    const multiVocab = Object.keys(this.doc?.vocabularies || {}).length > 1;
    const tag = (it) => {
      const parts = [];
      if (it.count) parts.push(`×${it.count}`);
      if (it.entry) parts.push(it.entryTrusted ? 'link' : 'unconfirmed link');
      // Rounded down, as every confidence is (plaid-ui domain/confidence.js).
      if (it.model)
        parts.push(it.prob != null ? `model ${Math.floor(it.prob * 100 + 1e-9)}%` : 'model');
      return parts.join(' · ');
    };
    return html`<div
      class="igt-alts"
      style=${posStyle}
      role="listbox"
      aria-label=${pairs ? 'Senses and values' : 'Values seen for this form'}
      @click=${(e) => e.stopPropagation()}
      @mousedown=${(e) => e.preventDefault()}
    >
      ${visible.length
        ? visible.map(
            (it, i) =>
              html`<div
                class="igt-alts__item ${it.pair ? 'igt-pair' : ''} ${i === a.active
                  ? 'is-active'
                  : ''} ${it.context ? 'is-context' : ''}"
                style=${it.depth ? `--igt-depth:${it.depth}` : ''}
                role="option"
                aria-selected=${i === a.active}
                @click=${() => this._pickAltByKey(cellKey, it)}
              >
                ${it.pair
                  ? this._pairRowCells(it, { multiVocab })
                  : html`<span class="igt-alts__value" dir="auto">${it.value}</span>
                      <span class="igt-alts__desc">${it.description ?? nothing}</span>
                      <span class="igt-alts__tag">${tag(it)}</span>`}
              </div>`,
          )
        : html`<div class="igt-alts__empty">No matching values</div>`}
    </div>`;
  },

  // Guess confirmation: Enter on an empty cell showing a guess adopts the
  // guess into the input value (marked confirmed so the blur-commit attaches
  // provenance) and then proceeds with normal navigation, whose focus change
  // blurs and commits. Tab and Shift+Enter deliberately do NOT adopt (user
  // decisions 2026-08-26 and 2026-09-13): moving across a row to reach a cell
  // must never write the guesses it passes over. Typing replaces the guess (it's just a
  // placeholder); plain blur leaves the cell empty — guesses are never written
  // implicitly.
  _maybeConfirmGuess(el) {
    if (el.value === '' && el.dataset.guessValue) {
      el.value = el.dataset.guessValue;
      el.dataset.guessConfirmed = '1';
      this._syncInput(el);
      // One cell, so the pulse is on the cell. No beat: the caret is one step
      // away, not a word away, and this is the gesture a person makes hundreds
      // of times an hour -- 200ms of held-back caret would be felt as lag.
      this._pulse(el.closest('.igt-cell, .igt-morph-cell'));
    }
  },
};

// See the note at the end of IgtEditor.js: an island's live instance keeps
// its old prototype, so a change here forces a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
