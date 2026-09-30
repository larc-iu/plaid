import { settleKey } from '../pendingIds.js';
import { setUnsavedDraft } from '../../hooks/useUnsavedDraft.js';

// What becomes of a grid cell's edit that the server refused, one copy for
// every app's grid (Luke's ruling Q1, 2026-09-29). The engine holds the
// state and decides. An app keeps the drawing: the input, the note under a
// cell that lost, the class for a value waiting to be sent again. It knows
// nothing of React or lit, and nothing of any app. An adapter
// (hooks/useConflictCell.js for React, domCells.js for hand-made DOM) wires a
// drawn cell to it.
//
// A cell is named by a key the app mints for one value of one entity, an
// opaque string. Every record is kept under `canonicalKey(key)`, which by
// default puts the server's id in place of a pending one, so a record follows
// its row across the swap.
//
// A cell's states:
// - idle: nothing held. The cell shows what is stored.
// - editing: the drawn cell has focus. A value waiting for it was taken up
//   (`focus`), and leaving the cell sends it.
// - saving: edits of the cell on their way (`sending`, then `settle`).
// - unsent: a refused value put back, waiting to be sent again. It shows in
//   its cell while the stored value is still the one it was typed over, and
//   counts as typed and not saved, so leaving the page asks first.
// - conflicted: someone else stored another value first. The cell shows the
//   stored value with the refused one under it. Enter keeps the refused one
//   (`keepYours`), Escape or typing lets it go (`dismiss`), and leaving the
//   cell sends nothing. Leaving the page does not ask about it.
//
// The reader (`read`) answers from the document, never from what a cell
// shows, so a cell not drawn right now (another page) is decided the same way
// as a drawn one.
//
// A lost answer is sent again under its Idempotency-Key until it is answered
// (plaid-ui WriteQueue), so it comes back as landed. `landedUnheard` is for a
// refusal whose read-back holds the typed value: someone stored the same.

const WHAT = 'An annotation you have typed';
const SEVERAL = 'annotations you have typed';

// Refusals that sending the value again cannot mend: no longer a writer, or
// what it names is gone.
const FINAL = new Set([403, 404]);

// Refusals of the value itself: it breaks a rule the layer declares (a closed
// value set, a relation's shape). Sending it again is refused again, and it is
// no one else's change, so the cell shows what is stored and keeps nothing.
// The document's own toast gives the reason.
const REJECTED = new Set([422]);

const settlePending = settleKey;

export class CellEngine {
  /**
   * - `read(key)`: the value stored now, '' for none, or undefined when the
   *   row is gone.
   * - `shape(key)`: an opaque snapshot of what the value is typed for (the
   *   word, the morpheme, the sentence), or null.
   * - `recut(snapshot, key)`: `{ unit, text }` when what the cell is on was
   *   split, joined or respelled since `snapshot`, else null.
   * - `view(key, canonical)`: the drawn cell, a CellView, or null.
   * - `announce(event)`: hears `{ kind: 'conflict', key, typed, stored, recut,
   *   entityIds }`, `{ kind: 'keptInCell', key, field }` and `{ kind: 'lost',
   *   key, typed, field }` (cellConflict.js `announceCells` words them).
   * - `describe(key)`: the leave question's name for the cell, or null.
   * - `entityIds(key)`: the ids of what the cell writes as stored now, for
   *   the toast's lookup of who changed it.
   *
   * A CellView: `{ focused(), typedSince(typed), takeUp({ typed, saved }),
   * showStored(value, { conflict }), update() }`.
   */
  constructor({
    read,
    shape = null,
    recut = null,
    view = null,
    announce = null,
    describe = null,
    entityIds = null,
    canonicalKey = settlePending,
    finalStatuses = FINAL,
    rejectedStatuses = REJECTED,
  } = {}) {
    this._read = read;
    this._shape = shape;
    this._recut = recut;
    this._view = view;
    this._announce = announce;
    this._describe = describe;
    this._entityIds = entityIds;
    this._canonical = canonicalKey;
    this._final = finalStatuses;
    this._rejected = rejectedStatuses;
    // canonical key -> { key, typed, saved, shape, what, field, token }. `token`
    // is the entry's registration with the leave question.
    this._unsent = new Map();
    // canonical key -> { key, typed, stored, recut }.
    this._conflicts = new Map();
    // canonical key -> { base, open, latest }: the edits of the cell still on
    // their way. `base` is what the server held before them, and moves on
    // when one lands.
    this._flights = new Map();
    // canonical key -> a value a refusal put back into its focused cell
    // (`takeUp`): older than the refusal after it, so not typing since.
    this._putBacks = new Map();
    this._listeners = new Set();
  }

  get size() {
    return this._unsent.size + this._conflicts.size;
  }

  /** Whether any value waits to be sent again. */
  get hasUnsent() {
    return this._unsent.size > 0;
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _changed(key, quiet = false) {
    if (key != null) this._viewOf(key)?.update?.();
    if (!quiet) this._listeners.forEach((fn) => fn());
  }

  /** The key a record for `key` is kept under. */
  canonical(key) {
    return this._canonical(key);
  }

  _viewOf(key) {
    return this._view ? this._view(key, this._canonical(key)) : null;
  }

  // The app's readers are asked with the key as the server knows it now.
  _readNow(key) {
    return this._read ? this._read(this._canonical(key)) : undefined;
  }

  _shapeNow(key) {
    return this._shape?.(this._canonical(key)) ?? null;
  }

  _recutSince(snapshot, key) {
    return this._recut?.(snapshot, this._canonical(key)) ?? null;
  }

  /** The conflict standing on the cell, `{ typed, stored, recut }`, or null. */
  conflictOf(key) {
    const c = this._conflicts.get(this._canonical(key));
    return c ? { typed: c.typed, stored: c.stored, recut: c.recut } : null;
  }

  /** The value waiting to be sent again from the cell, `{ typed, saved }`, or null. */
  unsentOf(key) {
    const u = this._unsent.get(this._canonical(key));
    return u ? { typed: u.typed, saved: u.saved } : null;
  }

  /** A value a refusal put back into the focused cell, or null. */
  putBackOf(key) {
    return this._putBacks.get(this._canonical(key)) ?? null;
  }

  /**
   * What the cell shows at rest over `stored`: the value waiting for it while
   * `stored` is still the one it was typed over, else `stored`.
   */
  display(key, stored) {
    const u = this._unsent.get(this._canonical(key));
    return u && stored === u.saved ? u.typed : stored;
  }

  _take(k) {
    const u = this._unsent.get(k);
    if (!u) return null;
    this._unsent.delete(k);
    setUnsavedDraft(u.token, null);
    return u;
  }

  _put(key, entry) {
    const k = this._canonical(key);
    const prior = this._unsent.get(k);
    const token = prior?.token ?? {};
    const what = entry.what ?? prior?.what ?? this._describe?.(key) ?? null;
    this._unsent.set(k, { ...entry, key, what, token });
    setUnsavedDraft(token, what ?? WHAT, SEVERAL);
  }

  /**
   * The cell took focus: a value waiting for it is taken up, and leaving the
   * cell sends it. Answers `{ typed, saved }`, or null.
   */
  focus(key) {
    const u = this._take(this._canonical(key));
    if (!u) return null;
    // The cell's own act, and it shows the value already: nothing to redraw,
    // and a redraw from inside a focus handler would race the cell's baseline.
    this._changed(key, true);
    return { typed: u.typed, saved: u.saved };
  }

  /**
   * A value taken up by a cell that went away with focus in it (a page
   * turned from the keyboard) goes back to wait for the cell.
   */
  release(key, typed, saved) {
    this._put(key, { typed, saved, shape: this._shapeNow(key), field: null });
    this._changed(key);
  }

  /**
   * An edit of the cell going out, `typed` over `saved`, the value stored
   * under it as the cell had it. Answers a ticket for `settle`. `entityIds`
   * name what it writes, `field` names the cell in a refusal's toast, and
   * `what` in the leave question.
   */
  sending(key, { saved = '', typed = '', entityIds = [], field = null, what = null } = {}) {
    const k = this._canonical(key);
    let flight = this._flights.get(k);
    if (!flight) {
      flight = { base: saved, open: 0, latest: 0 };
      this._flights.set(k, flight);
    }
    flight.open += 1;
    flight.latest += 1;
    const conflicted = this._conflicts.delete(k);
    const waiting = this._take(k) != null;
    const putBack = this._putBacks.delete(k);
    if (conflicted || waiting || putBack) this._changed(key);
    return {
      key,
      k,
      flight,
      n: flight.latest,
      typed,
      shape: this._shapeNow(key),
      entityIds,
      field,
      what,
    };
  }

  /**
   * The answer to the edit `ticket` stands for came: `{ landed: true }`, or
   * `{ landed: false, status, readBack }`, where `readBack` says the document
   * was read again after the refusal, so what it holds is what the server
   * holds. Applies what that means and answers the decision, `{ kind, typed,
   * stored, recut, status }`, `kind` one of 'landed', 'superseded',
   * 'typedSince', 'gone', 'rejected', 'landedUnheard', 'conflict', 'dropped',
   * 'takenUp' and 'putBack'.
   */
  settle(ticket, outcome = {}) {
    const { key, k, flight, n, typed } = ticket;
    flight.open -= 1;
    const superseded = n !== flight.latest;
    const base = flight.base;
    if (outcome.landed) flight.base = typed;
    if (!flight.open && this._flights.get(k) === flight) this._flights.delete(k);
    if (outcome.landed) {
      if (this._putBacks.delete(k)) this._changed(key);
      return { kind: 'landed', typed };
    }
    const status = outcome.status ?? null;
    // A later edit of the same cell is still out: its value is the newer one,
    // and it answers for itself.
    if (superseded) return { kind: 'superseded', typed, status };
    const view = this._viewOf(key);
    // Typed into again since this edit went out: that text is newer, and
    // leaving the cell sends it.
    if (view?.typedSince?.(typed)) return { kind: 'typedSince', typed, status };
    const now = this._readNow(key);
    if (now === undefined) {
      // The row is gone: there is no cell to put it back into.
      this._conflicts.delete(k);
      this._take(k);
      if (status === 409) {
        this._announce?.({ kind: 'lost', key, typed, field: ticket.field });
      }
      this._changed(key);
      return { kind: 'gone', typed, status };
    }
    if (this._rejected.has(status)) {
      const shown = now === typed && !outcome.readBack ? base : now;
      view?.showStored?.(shown, { conflict: false });
      this._changed(key);
      return { kind: 'rejected', typed, stored: shown, status };
    }
    // Read again after the refusal and holding the typed value: the edit is
    // stored (its answer was lost on the way back), or someone stored the
    // same.
    if (outcome.readBack && now === typed) {
      view?.showStored?.(now, { conflict: false });
      this._changed(key);
      return { kind: 'landedUnheard', typed, stored: now, status };
    }
    // Still showing the edit itself: the read after the refusal did not come.
    const stored = now === typed ? base : now;
    if (stored !== base) {
      this.conflict(key, typed, stored, null, ticket.entityIds);
      return { kind: 'conflict', typed, stored, recut: null, status };
    }
    const final = this._final.has(status);
    const recut = final ? null : this._recutSince(ticket.shape, key);
    if (recut != null) {
      this.conflict(key, typed, stored, recut, ticket.entityIds);
      return { kind: 'conflict', typed, stored, recut, status };
    }
    if (final) {
      view?.showStored?.(stored, { conflict: false });
      this._changed(key);
      return { kind: 'dropped', typed, stored, status };
    }
    // Refused as a conflict that is not this cell's: another change came
    // first elsewhere. The value goes back to be sent again.
    if (status === 409) this._announce?.({ kind: 'keptInCell', key, field: ticket.field });
    if (view?.takeUp?.({ typed, saved: stored })) {
      this._putBacks.set(k, typed);
      this._changed(key);
      return { kind: 'takenUp', typed, stored, status };
    }
    this._put(key, {
      typed,
      saved: stored,
      shape: ticket.shape,
      what: ticket.what,
      field: ticket.field,
    });
    this._changed(key);
    return { kind: 'putBack', typed, stored, status };
  }

  /**
   * `typed` lost to `stored`, which someone else wrote. Nothing is held when
   * the two agree. `recut` is `{ unit, text }` when what the cell is on was
   * re-cut meanwhile.
   */
  conflict(key, typed, stored, recut = null, entityIds = null) {
    this._conflict(key, typed, stored, recut, entityIds, false);
  }

  _conflict(key, typed, stored, recut, entityIds, quiet) {
    const k = this._canonical(key);
    this._take(k);
    this._putBacks.delete(k);
    if (typed === stored) {
      this._conflicts.delete(k);
      this._changed(key, quiet);
      return;
    }
    this._conflicts.set(k, { key, typed, stored, recut });
    this._viewOf(key)?.showStored?.(stored, { conflict: true });
    this._changed(key, quiet);
    const ids = [...(entityIds ?? []), ...(this._entityIds?.(this._canonical(key)) ?? [])].filter(
      Boolean,
    );
    this._announce?.({ kind: 'conflict', key, typed, stored, recut, entityIds: ids });
  }

  /** Enter in a cell that lost: its value is kept. Answers it, or null. */
  keepYours(key) {
    const k = this._canonical(key);
    const c = this._conflicts.get(k);
    if (!c) return null;
    this._conflicts.delete(k);
    this._changed(key);
    return c.typed;
  }

  /** Escape, or typing another value, lets a conflict go. */
  dismiss(key) {
    if (!this._conflicts.delete(this._canonical(key))) return false;
    this._changed(key);
    return true;
  }

  /**
   * Go over every value held against what is stored now. A value waiting to
   * be sent again whose stored value moved on, or whose word was re-cut,
   * turns into a conflict. One whose stored value is now the typed one, or
   * whose row is gone, is let go. A conflict whose stored value moved on
   * again is let go. `quiet` tells no subscriber (the caller is drawing).
   * Answers whether anything changed.
   */
  reconcile({ quiet = false } = {}) {
    let changed = false;
    for (const [k, u] of [...this._unsent]) {
      const now = this._readNow(u.key);
      const recut = now === undefined ? null : this._recutSince(u.shape, u.key);
      if (recut != null) {
        this._conflict(u.key, u.typed, now, recut, null, true);
        changed = true;
        continue;
      }
      if (now === u.saved) continue;
      changed = true;
      if (now === undefined || now === u.typed) {
        this._take(k);
        this._viewOf(u.key)?.update?.();
      } else {
        this._conflict(u.key, u.typed, now, null, null, true);
      }
    }
    for (const [k, c] of [...this._conflicts]) {
      if (this._readNow(c.key) === c.stored) continue;
      this._conflicts.delete(k);
      this._viewOf(c.key)?.update?.();
      changed = true;
    }
    if (changed && !quiet) this._listeners.forEach((fn) => fn());
    return changed;
  }

  /** Let go of everything: the grid is gone. */
  clear() {
    for (const k of [...this._unsent.keys()]) this._take(k);
    this._conflicts.clear();
    this._flights.clear();
    this._putBacks.clear();
  }
}
