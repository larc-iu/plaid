import { render, html, nothing } from 'lit-html';
import { TAGSET_SOURCE } from '@/domain/glossGuess';
import { isValueAllowed, replacePartAtCaret } from '@/domain/tagsets';

// The alternatives list: Alt+Down on a cell lists every value the project
// has given that form, and a pick adopts one.
export const alternatives = {
  // seen for the form (domain/glossGuess.js listAlternatives), ranked, with
  // its provenance. ↑↓ move, ↵ picks, Esc closes, typing narrows. A pick goes
  // through the guess-adoption path (data-guess-* + blur-commit), so it is
  // written born-verified with the row's source, exactly like adopting a
  // placeholder guess; the cell keeps focus.
  // `explicit`: the user asked for the list (Alt+Down), as opposed to a
  // governed cell opening it on focus. Escape reads the difference.
  _openAlts(el, { explicit = false } = {}) {
    const items = typeof el.igtAlts === 'function' ? el.igtAlts() : [];
    if (!items.length) return;
    this._alts = { cellKey: el.dataset.cellKey, active: 0, filter: '', visible: [], explicit };
    this._altsPos = this._computeAltsPos(el, items.length);
    this._renderAlts();
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
    const el = this._alts
      ? this.container.querySelector(`[data-cell-key="${this._alts.cellKey}"]`)
      : null;
    const items = el && typeof el.igtAlts === 'function' ? el.igtAlts() : null;
    render(
      this._alts && items ? this._altsTemplate(items, this._alts.cellKey) : nothing,
      this._altsRoot,
    );
  },

  // Returns true when the key was handled by the list.
  _altsKeydown(e) {
    const el = e.target;
    const open = !!this._alts && this._alts.cellKey === el.dataset.cellKey;
    if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) this._openAlts(el, { explicit: true });
      return true;
    }
    if (!open) return false;
    // Ctrl/Cmd+Enter is the whole-word accept wherever it is pressed; the list
    // never takes it, steered or not.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      this._closeAlts();
      return false;
    }
    const items = this._alts.visible || [];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length;
      if (n) {
        this._alts.active = (this._alts.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        // The user has now steered the list, so Enter belongs to it.
        this._alts.steered = true;
        this._renderAlts();
      }
      return true;
    }
    if (e.key === 'Enter') {
      // Whose key is this, the list's or the cell's? The list opens on focus
      // for a governed cell, so Enter arrives here on every plain "commit and
      // move on" too, and those have to be handed back. The list keeps Enter
      // only when taking the highlighted row is plainly what the user wants:
      //
      //   steered      they arrowed to a row. Theirs, whatever the mode.
      //   completing   on an ENFORCING tagset they typed a prefix that is not
      //                itself a legal value, and a row matches it. The prefix
      //                cannot be committed, so the row is what they can have.
      //
      // Everything else falls through to the ordinary Enter: nothing typed
      // (an untouched cell — Enter there once replaced a stored PL with the
      // form's most frequent gloss, and in part mode the first part of
      // 1SG.NOM, since focus select-all leaves the caret at 0), a suggesting
      // tagset (the typed text is a legal new value), a typed part that is
      // already legal (NOM typed out in full), or a pick that would not
      // change the value.
      const it = items.length ? items[this._alts.active] : null;
      const typed = this._alts.filter || '';
      const enforcing = el.dataset.tagsetEnforces === '1';
      const delims = el.dataset.tagsetDelims || '';
      const would = it
        ? delims
          ? replacePartAtCaret(el.value, el.selectionStart, delims, it.value).value
          : it.value
        : null;
      const completing = typed !== '' && enforcing && !isValueAllowed(typed, el.igtTagset ?? null);
      if (!it || would === el.value || !(this._alts.steered || completing)) {
        this._closeAlts();
        return false; // fall through to the normal commit path
      }
      e.preventDefault();
      this._pickAlt(el, it, { advance: true });
      return true;
    }
    if (e.key === 'Escape') {
      // The same question as Enter: is the list what the user is addressing?
      // A list that opened on its own and has not been typed into or steered
      // is not, so Escape falls through and reverts the cell in one press,
      // as it does everywhere else. A list the user ASKED for (Alt+Down) is,
      // and so is one mid-completion: Escape closes the list, keeps what was
      // typed, and leaves the cell where it is.
      const engaged =
        !!this._alts.steered || !!this._alts.explicit || (this._alts.filter || '') !== '';
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
    const delims = el.dataset.tagsetDelims || '';
    if (delims) {
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
    if (item.source !== TAGSET_SOURCE && !delims) {
      el.igtPick = { value: item.value, source: item.source };
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
    const same = this.container.querySelector(`[data-cell-key="${key}"]`);
    if (same) {
      this._skipAltsOnFocus = true;
      same.focus();
    }
  },

  _pickAltByKey(cellKey, item) {
    const el = this.container.querySelector(`[data-cell-key="${cellKey}"]`);
    if (el) this._pickAlt(el, item);
  },

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
  },

  _repositionAlts() {
    if (!this._alts) return;
    const el = this.container.querySelector(`[data-cell-key="${this._alts.cellKey}"]`);
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
    const f = (a.filter || '').toLowerCase();
    const visible = f ? items.filter((it) => it.value.toLowerCase().startsWith(f)) : items;
    a.visible = visible;
    if (a.active >= visible.length) a.active = 0;
    const pos = this._altsPos;
    const posStyle = pos ? `left:${pos.left}px;top:${pos.top}px;min-width:${pos.width}px;` : '';
    const tag = (it) => {
      const parts = [];
      if (it.count) parts.push(`×${it.count}`);
      if (it.entry) parts.push(it.entryTrusted ? 'link' : 'unconfirmed link');
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
                <span class="igt-alts__desc">${it.description ?? nothing}</span>
                <span class="igt-alts__tag">${tag(it)}</span>
              </div>`,
          )
        : html`<div class="igt-alts__empty">No matching values</div>`}
    </div>`;
  },

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
