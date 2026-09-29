import { setUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';

// Values put back after they were not saved (refused, or after a conflict
// refused unsent), `{ typed, saved }` by token and field, held
// for the whole annotation grid rather than by the cell showing one.
//
// The grid pages its sentences, and a cell on a page the reader has left is
// unmounted. Held by the cell, its value went with it, and so did the question
// before leaving. Held here, it waits for its cell to be drawn again, which
// then shows it, and every one waiting counts as typed and not saved, whether
// its cell is on screen or not.
//
// A value is put back only while the stored value is still the one it was
// typed over (`saved`). Once someone else has stored another value there, the
// refused one is a conflict instead: the cell shows the stored value, with the
// refused one beside it, and leaving the cell sends nothing. Enter in the cell
// keeps the refused one. A conflict is not unsaved typing, so it asks nothing
// before leaving.
//
// An entry leaves when its cell is taken up (focused: leaving the cell sends
// it), when the stored value is no longer the one it was typed over (it turns
// into a conflict), when its token is gone, and when the grid goes. A conflict
// leaves when the cell is committed or cancelled, when the stored value moves
// on again, when its token is gone, and when the grid goes.
//
// `saved` is the value it was typed over. For a cell edited twice behind a
// refusal the first edit's `saved` stands, since the second was typed over a
// value the server never had.
//
// `storedValue(tokenId, field)` answers the value stored now, '' for none, or
// undefined for a token no longer in the document. `onConflict(tokenId, field,
// stored, typed, recut)` hears each new conflict.
//
// A token re-cut since the value was typed (its word split or joined by
// someone else, which can keep the token's id) makes a conflict too, whatever
// is stored: the value was typed for a word that is not there any more, and
// sending it again on leaving would store it on another. `tokenShape(tokenId)`
// answers `{ key, text }`, `key` changing when the token is re-cut and `text`
// the word as it reads now, which `onConflict` hears as `recut`.
//
// A drawn cell hears `{ type: 'put', typed, saved }` (a value put back: it
// answers true when it takes it up itself, having focus), `{ type: 'conflict',
// typed, stored }` and `{ type: 'gone' }` (what it showed was let go).

const WHAT = 'An annotation you have typed';
const SEVERAL = 'annotations you have typed';

const keyOf = (tokenId, field) => `${tokenId}:${field}`;

export class UnsentValues {
  constructor(storedValue = null, { onConflict = null, tokenShape = null } = {}) {
    this._storedValue = storedValue;
    this._onConflict = onConflict;
    this._tokenShape = tokenShape;
    // key -> { tokenId, field, typed, saved, token }. `token` is the entry's
    // own registration with the leave question.
    this._entries = new Map();
    // key -> { tokenId, field, typed, stored }.
    this._conflicts = new Map();
    // key -> the one mounted cell's listener.
    this._cells = new Map();
    // key -> the edits of this cell still on their way, `{ base, latest,
    // open }`. See `sending`.
    this._flights = new Map();
  }

  get size() {
    return this._entries.size + this._conflicts.size;
  }

  _stored(tokenId, field, fallback) {
    return this._storedValue ? this._storedValue(tokenId, field) : fallback;
  }

  _shapeKey(tokenId) {
    return this._tokenShape?.(tokenId)?.key;
  }

  // The word as it reads now, when the token was re-cut since `shape` was
  // read, else null.
  _recut(tokenId, shape) {
    if (shape == null) return null;
    const now = this._tokenShape?.(tokenId);
    return now && now.key !== shape ? now.text : null;
  }

  _tell(tokenId, field, message) {
    const cell = this._cells.get(keyOf(tokenId, field));
    return cell ? cell(message) : false;
  }

  /** The value waiting for this cell, `{ typed, saved }`, or null. */
  get(tokenId, field) {
    const entry = this._entries.get(keyOf(tokenId, field));
    return entry ? { typed: entry.typed, saved: entry.saved } : null;
  }

  /** The conflict standing on this cell, `{ typed, stored }`, or null. */
  conflictOf(tokenId, field) {
    const c = this._conflicts.get(keyOf(tokenId, field));
    return c ? { typed: c.typed, stored: c.stored } : null;
  }

  /**
   * Put back `typed`, not saved over `saved`. Over a value someone else has
   * stored since, it is a conflict instead. For a token that is gone, and
   * with `resend: false` (a refusal that sending again cannot mend), nothing
   * is put back. The cell showing it, if one is drawn, is told first. A
   * focused cell takes it up and it goes no further. With `readBack` (the
   * refetch after the refusal landed), a stored value that is the typed one
   * means the edit is on the server (its answer was lost on the way back),
   * or someone stored the same: nothing is put back. `shape` is the token's
   * shape key when the value was typed (`settled` answers it): re-cut since,
   * it is a conflict. Answers what became of it: 'put', 'conflict', 'landed'
   * or 'dropped'.
   */
  put(tokenId, field, typed, saved, { resend = true, readBack = false, shape = null } = {}) {
    const key = keyOf(tokenId, field);
    const prior = this._entries.get(key);
    const typedOver = prior ? prior.saved : saved;
    const now = this._stored(tokenId, field, typedOver);
    if (now === undefined) {
      this.take(tokenId, field);
      this.resolve(tokenId, field);
      return 'dropped';
    }
    if (readBack && now === typed) {
      this.take(tokenId, field);
      this.resolve(tokenId, field);
      return 'landed';
    }
    // Still showing the edit itself: the refetch has not come yet, and the
    // cell hears what it brings when it comes.
    if (now !== typedOver && now !== typed) {
      this.conflict(tokenId, field, typed, now);
      return 'conflict';
    }
    const recut = resend ? this._recut(tokenId, prior ? prior.shape : shape) : null;
    if (recut != null) {
      this.conflict(tokenId, field, typed, now, recut);
      return 'conflict';
    }
    if (!resend) {
      this.take(tokenId, field);
      return 'dropped';
    }
    const value = { typed, saved: typedOver };
    this.resolve(tokenId, field);
    if (this._tell(tokenId, field, { type: 'put', ...value })) {
      this.take(tokenId, field);
      return 'put';
    }
    const token = prior?.token ?? {};
    const shapeKey = prior ? prior.shape : (shape ?? this._shapeKey(tokenId));
    this._entries.set(key, { tokenId, field, ...value, token, shape: shapeKey });
    setUnsavedDraft(token, WHAT, SEVERAL);
    return 'put';
  }

  /**
   * `typed` was refused over `stored`, which someone else wrote. Nothing is
   * held when the two agree.
   */
  conflict(tokenId, field, typed, stored, recut = null) {
    this.take(tokenId, field);
    if (typed === stored) {
      this.resolve(tokenId, field);
      return;
    }
    this._conflicts.set(keyOf(tokenId, field), { tokenId, field, typed, stored });
    this._tell(tokenId, field, { type: 'conflict', typed, stored });
    this._onConflict?.(tokenId, field, stored, typed, recut);
  }

  /** Let go of the conflict on this cell: the annotator has acted on it. */
  resolve(tokenId, field) {
    this._conflicts.delete(keyOf(tokenId, field));
  }

  /**
   * An edit of this cell going out, typed over `saved`. Answers a ticket for
   * `settled`. Edits of one cell answer in the order they were sent.
   */
  sending(tokenId, field, saved) {
    const key = keyOf(tokenId, field);
    let flight = this._flights.get(key);
    if (!flight) {
      flight = { base: saved, latest: 0, open: 0, shape: this._shapeKey(tokenId) };
      this._flights.set(key, flight);
    }
    flight.open++;
    flight.latest++;
    return { key, flight, n: flight.latest };
  }

  /**
   * The answer to the edit `ticket` stands for came, `landed` or not, with the
   * value it sent. Answers `superseded`, true when a later edit of the same
   * cell went out after it, and `saved`, what the server held under it: the
   * value the first edit still on its way was typed over, or the last one that
   * landed since. A refused edit with a later one behind it is not put back:
   * the later one is the annotator's value, and the refetch shows it again on
   * top of what is stored, which is not someone else's change. The later one,
   * refused in its turn, is measured against `saved`.
   */
  settled(ticket, landed, typed) {
    const { key, flight, n } = ticket;
    flight.open--;
    const answer = { superseded: n !== flight.latest, saved: flight.base, shape: flight.shape };
    if (landed) flight.base = typed;
    if (!flight.open && this._flights.get(key) === flight) this._flights.delete(key);
    return answer;
  }

  /** Remove and return what was waiting for this cell, or null. */
  take(tokenId, field) {
    const key = keyOf(tokenId, field);
    const entry = this._entries.get(key);
    if (!entry) return null;
    this._entries.delete(key);
    setUnsavedDraft(entry.token, null);
    return { typed: entry.typed, saved: entry.saved };
  }

  /** The drawn cell for a token and field hears what happens to its value. */
  listen(tokenId, field, fn) {
    const key = keyOf(tokenId, field);
    this._cells.set(key, fn);
    return () => {
      if (this._cells.get(key) === fn) this._cells.delete(key);
    };
  }

  /**
   * Go over every value against what is stored now, `storedValue(tokenId,
   * field)` as above (the one given to the constructor when none is passed).
   * A value whose stored value has moved on turns into a conflict, one whose
   * token is gone is let go, and a conflict whose stored value has moved on
   * again is let go.
   */
  prune(storedValue = this._storedValue) {
    if (!storedValue) return;
    for (const entry of [...this._entries.values()]) {
      const now = storedValue(entry.tokenId, entry.field);
      const recut = now === undefined ? null : this._recut(entry.tokenId, entry.shape);
      if (recut != null) {
        this.conflict(entry.tokenId, entry.field, entry.typed, now, recut);
        continue;
      }
      if (now === entry.saved) continue;
      if (now === undefined || now === entry.typed) {
        this.take(entry.tokenId, entry.field);
        this._tell(entry.tokenId, entry.field, { type: 'gone' });
      } else this.conflict(entry.tokenId, entry.field, entry.typed, now);
    }
    for (const c of [...this._conflicts.values()]) {
      if (storedValue(c.tokenId, c.field) === c.stored) continue;
      this.resolve(c.tokenId, c.field);
      this._tell(c.tokenId, c.field, { type: 'gone' });
    }
  }

  /** Let go of all of them: the grid is gone. */
  clear() {
    for (const entry of [...this._entries.values()]) this.take(entry.tokenId, entry.field);
    this._conflicts.clear();
    this._flights.clear();
  }
}
