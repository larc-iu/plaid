import { setUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';

// Values put back after they were not saved (refused, or queued behind a
// refused edit and never sent), `{ typed, saved }` by token and field, held
// for the whole annotation grid rather than by the cell showing one.
//
// The grid pages its sentences, and a cell on a page the reader has left is
// unmounted. Held by the cell, its value went with it, and so did the question
// before leaving. Held here, it waits for its cell to be drawn again, which
// then shows it, and every one waiting counts as typed and not saved, whether
// its cell is on screen or not.
//
// An entry leaves when its cell is taken up (focused: leaving the cell sends
// it), when the stored value is no longer the one it was typed over, when its
// token is gone, and when the grid goes.
//
// `saved` is the value it was typed over. For a cell edited twice behind a
// refusal the first edit's `saved` stands, since the second was typed over a
// value the server never had.

const WHAT = 'An annotation you have typed';
const SEVERAL = 'annotations you have typed';

const keyOf = (tokenId, field) => `${tokenId}:${field}`;

export class UnsentValues {
  constructor() {
    // key -> { tokenId, field, typed, saved, token }. `token` is the entry's
    // own registration with the leave question.
    this._entries = new Map();
    // key -> the one mounted cell's listener.
    this._cells = new Map();
  }

  get size() {
    return this._entries.size;
  }

  /** The value waiting for this cell, `{ typed, saved }`, or null. */
  get(tokenId, field) {
    const entry = this._entries.get(keyOf(tokenId, field));
    return entry ? { typed: entry.typed, saved: entry.saved } : null;
  }

  /**
   * Put back `typed`, not saved over `saved`. The cell showing it, if one is
   * drawn, is told first. A focused cell takes it up and it goes no further.
   */
  put(tokenId, field, typed, saved) {
    const key = keyOf(tokenId, field);
    const prior = this._entries.get(key);
    const value = { typed, saved: prior ? prior.saved : saved };
    const cell = this._cells.get(key);
    if (cell && cell(value)) {
      this.take(tokenId, field);
      return;
    }
    const token = prior?.token ?? {};
    this._entries.set(key, { tokenId, field, ...value, token });
    setUnsavedDraft(token, WHAT, SEVERAL);
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

  /**
   * The drawn cell for a token and field hears each value put back for it.
   * It answers true when it takes the value up itself (it has focus).
   */
  listen(tokenId, field, fn) {
    const key = keyOf(tokenId, field);
    this._cells.set(key, fn);
    return () => {
      if (this._cells.get(key) === fn) this._cells.delete(key);
    };
  }

  /**
   * Let go of every value whose stored value has moved on or whose token is
   * gone. `storedValue(tokenId, field)` answers the value now stored, '' for
   * none, or undefined for a token no longer in the document.
   */
  prune(storedValue) {
    for (const entry of [...this._entries.values()]) {
      const now = storedValue(entry.tokenId, entry.field);
      if (now === undefined || now !== entry.saved) this.take(entry.tokenId, entry.field);
    }
  }

  /** Let go of all of them: the grid is gone. */
  clear() {
    for (const entry of [...this._entries.values()]) this.take(entry.tokenId, entry.field);
  }
}
