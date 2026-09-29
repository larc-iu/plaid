import { html, nothing } from 'lit-html';
import { settledId } from '@ui/domain/pendingIds.js';
import { cellByKey } from './shared.js';
import { notifyWarning } from '@/utils/feedback';

// A cell edit refused because another user changed the cell first (Luke's
// ruling Q1, 2026-09-29, the same in plaid-ud). The cell shows the stored
// value, which is theirs, and the refused one hangs under it: "Yours: X ·
// Enter to keep yours". Enter writes it over theirs, on purpose. Escape or
// typing another value lets it go, and leaving the cell sends nothing. It
// stays until then or until the stored value changes again, including while
// its page is not drawn, and it is not asked about on leaving the document.
// A toast names the change: "b changed this to DOG."
//
// Kept by cell key, with any pending id in it as the server knows it, in
// `this._conflicts`: `{ typed, stored }`.

const RECENT = 50;

// A cell key with its pending ids settled, so a conflict follows its row
// across the swap.
const conflictKey = (key) => (key ?? '').replace(/pending:\d+/g, (p) => settledId(p));

// An element id for the note of the cell `key` names: no white space, which
// an id list cannot hold.
const noteId = (key) => `igt-conflict-${encodeURIComponent(conflictKey(key))}`;

// The row a cell key names: `<kind>:<id>` for a morpheme form,
// `<kind>:<id>:<field>` for the rest, where the id may itself hold a colon
// (`virtual:<word>`, `pending:<n>`) and so may the field.
export const rowOfKey = (key) => {
  const rest = (key ?? '').slice(key.indexOf(':') + 1);
  return /^(virtual:[^:]+|pending:\d+|[^:]+)/.exec(rest)?.[1] ?? '';
};

// "b changed this to DOG." Words as plaid-ud's conflictNotice.js has them.
const changedTo = (who, stored) =>
  stored ? `${who || 'Someone'} changed this to ${stored}.` : `${who || 'Someone'} cleared this.`;

export const conflicts = {
  _conflictOf(key) {
    return this._conflicts.get(conflictKey(key)) ?? null;
  },

  // The note under a cell that lost a conflict, or nothing. It has no `dir`
  // of its own: it hangs from the start of its cell, which is the right edge
  // in a right-to-left sentence, and "Yours" would make it left to right. The
  // words are left to right and the value takes its own direction.
  _conflictNote(key) {
    const c = this.readOnly ? null : this._conflictOf(key);
    if (!c) return nothing;
    return html`<span class="igt-field-conflict" role="status" id=${noteId(key)}
      ><span dir="ltr">Yours: <bdi>${c.typed || '(none)'}</bdi> · Enter to keep yours</span></span
    >`;
  },

  // The id of a cell's conflict note, for the cell's aria-describedby, so a
  // screen reader arriving in the cell reads the note. Nothing when none.
  _conflictDescribedBy(key) {
    return !this.readOnly && this._conflictOf(key) ? noteId(key) : nothing;
  },

  // A refused edit of `cell` lost to `stored`, another user's value: the cell
  // shows theirs, with `typed` under it, and focus stays where it is unless it
  // was in this cell or nowhere.
  _enterConflict(cell, typed, stored) {
    const key = cell.dataset.cellKey;
    this._conflicts.set(conflictKey(key), { typed, stored });
    cell.igtUnsent = null;
    cell.value = stored;
    cell.dataset.orig = stored;
    this._syncCellClasses(cell, stored, cell.igtTagset ?? null);
    const active = document.activeElement;
    if (!active || active === document.body || active === cell) cell.focus();
    this._render(true);
    this._sayWhoChanged(cell, stored);
  },

  // The toast, once the document's audit log has said who: the newest change
  // by another user that wrote this cell's span or token, else the newest
  // change by another user at all.
  _sayWhoChanged(cell, stored) {
    const client = this.doc.client;
    const me = this.doc._user?.id;
    const ids = (cell.igtEntityIds ?? []).filter(Boolean).map(settledId);
    const who = async () => {
      const page = await client.documents.auditPage(this.doc.id, { order: 'desc', limit: RECENT });
      const others = (page?.entries ?? []).filter((e) => e.user?.id && e.user.id !== me);
      const wrote = (e) =>
        (e.ops ?? []).some((op) => ids.some((id) => op.description?.includes(id)));
      const entry = others.find(wrote) ?? others[0];
      return entry ? entry.user.displayName || entry.user.id : null;
    };
    Promise.resolve()
      .then(who)
      .catch(() => null)
      .then((name) => notifyWarning(changedTo(name, stored)));
  },

  // Keys a cell that lost a conflict answers before anything else does. Plain
  // Enter with nothing typed since puts the refused value back in and lets
  // the handler go on, which commits it and moves on. Escape lets it go.
  _conflictKeys(e) {
    const el = e.target;
    const key = conflictKey(el?.dataset?.cellKey);
    const c = this._conflicts.get(key);
    if (!c) return;
    if (e.key === 'Escape') {
      this._dropConflict(el);
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (el.value !== (el.dataset.orig ?? '')) return;
    this._conflicts.delete(key);
    el.value = c.typed;
    this._syncInput(el);
    this._render(true);
  },

  // Typing another value, or Escape, lets a conflict go.
  _dropConflict(el) {
    if (this._conflicts.delete(conflictKey(el?.dataset?.cellKey))) this._render(true);
  },

  // After a render: a conflict whose stored value has changed again, or
  // whose row is gone from the document, is let go. One whose cell is not
  // drawn (another page) stays.
  _syncConflicts() {
    if (!this._conflicts.size) return;
    let ids = null;
    let gone = false;
    for (const [key, c] of this._conflicts) {
      const cell = cellByKey(this.container, key, '.igt-field');
      if (cell) {
        if ((cell.igtRendered ?? cell.value) !== c.stored) gone = this._conflicts.delete(key);
        continue;
      }
      ids ??= this._shownIds();
      if (!ids.has(rowOfKey(key))) this._conflicts.delete(key);
    }
    // The render just made drew the note of one let go.
    if (gone) this._render(true);
  },
};

// See the note at the end of IgtEditor.js: an island's live instance keeps
// its old prototype, so a change here forces a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
