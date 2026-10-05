import { html, nothing } from 'lit-html';
import { conflictNoteParts } from '@ui/lib/cellConflict.js';

// A cell edit refused because another user changed the cell first (Luke's
// ruling Q1, 2026-09-29, the same in plaid-ud). The cell shows the stored
// value, which is theirs, and the refused one hangs under it: "Yours: X ·
// Enter to keep yours". Enter writes it over theirs, on purpose. Escape or
// typing another value lets it go, and leaving the cell sends nothing. It
// stays until then or until the stored value changes again, including while
// its page is not drawn, and it is not asked about on leaving the document.
// A toast names the change: "b changed this to DOG."
//
// The cell engine holds it (`this._cells`, plaid-ui cells/CellEngine.js).
// This is the drawing and the keys.

// An element id for the note of the cell `key` names: no white space, which
// an id list cannot hold.
const noteId = (cells, key) => `igt-conflict-${encodeURIComponent(cells.canonical(key))}`;

export const conflicts = {
  // The note under a cell that lost a conflict, or nothing. It has no `dir`
  // of its own: it hangs from the start of its cell, which is the right edge
  // in a right-to-left sentence, and "Yours" would make it left to right. The
  // words are left to right and the value takes its own direction. The hint
  // after the value shows only while the cell has focus, where Enter does
  // what it says, so the notes of neighbouring cells do not run over each
  // other. A screen reader reads it all the same.
  _conflictNote(key) {
    const c = this.readOnly ? null : this._cells.conflictOf(key);
    if (!c) return nothing;
    const { before, value, after } = conflictNoteParts(c.typed);
    return html`<span class="igt-field-conflict" role="status" id=${noteId(this._cells, key)}
      ><span dir="ltr"
        >${before}<bdi>${value}</bdi><span class="igt-field-conflict__hint">${after}</span></span
      ></span
    >`;
  },

  // The id of a cell's conflict note, for the cell's aria-describedby, so a
  // screen reader arriving in the cell reads the note. Nothing when none.
  _conflictDescribedBy(key) {
    return !this.readOnly && this._cells.conflictOf(key) ? noteId(this._cells, key) : nothing;
  },

  // Keys a cell that lost a conflict answers before anything else does. Plain
  // Enter with nothing typed since puts the refused value back in and lets
  // the handler go on, which commits it and moves on. Escape lets it go.
  _conflictKeys(e) {
    const el = e.target;
    const key = el?.dataset?.cellKey;
    const c = key == null ? null : this._cells.conflictOf(key);
    if (!c) return;
    if (e.key === 'Escape') {
      this._cells.dismiss(key);
      // Read by _escapeCell, so this Escape does not also arm the grid leave.
      e.igtNoteDismissed = true;
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (el.value !== (el.dataset.orig ?? '')) return;
    // The value goes in before the engine lets the conflict go, so the render
    // that follows finds the cell typed into and leaves it be.
    el.value = c.typed;
    this._syncInput(el);
    this._cells.keepYours(key);
  },
};

// See the note at the end of IgtEditor.js: an island's live instance keeps
// its old prototype, so a change here forces a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
