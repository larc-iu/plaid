import { UDDocument } from './UDDocument.js';

export class DocumentStore {
  constructor() {
    this._doc = null;
    this._client = null;
    this._listeners = new Map();
  }

  // ── Subscribe / unsubscribe ────────────────────────────────────

  on(channel, fn) {
    let set = this._listeners.get(channel);
    if (!set) { set = new Set(); this._listeners.set(channel, set); }
    set.add(fn);
  }

  off(channel, fn) {
    this._listeners.get(channel)?.delete(fn);
  }

  emit(channel) {
    this._listeners.get(channel)?.forEach(fn => fn());
  }

  // ── Document access ────────────────────────────────────────────

  get document() {
    return this._doc;
  }

  // ── Full replacement (initial load, undo to checkpoint) ────────

  replaceDocument(raw, client) {
    if (client) this._client = client;
    this._doc = new UDDocument(raw, this._client);
    this.emit('document');
  }

  // ── Partial update — invalidate + emit fine-grained channel ────

  invalidateAndEmit(channel) {
    this._doc?.invalidate();
    this.emit(channel);
  }

  // ── Clear ──────────────────────────────────────────────────────

  clear() {
    this._doc = null;
    this._client = null;
    this._listeners.clear();
  }
}
