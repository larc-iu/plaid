// The lifecycle every editable document shares, whichever app's linguistics sit
// on top: the raw document and who is writing it, a subscription a React hook
// or a vanilla island can follow, the single-flight saving gate that runs each
// mutation as one logical operation and resyncs on failure, the optimistic raw
// patch, reload in place, and the snapshot beside the live document. What a
// document MEANS (its layers, rows, and every mutation) is the subclass's.
//
// Imports one sibling with no imports of its own, and nothing else: plaid-ud's
// node suite reaches this file by relative path, where no alias and no package
// resolves. Errors leave through `onError`.

import {
  AUTO,
  LTR,
  RTL,
  readTextDirection,
  resolveDirection,
  textDirectionOps,
  withTextDirection,
} from './textDirection.js';

const cloneRaw = (raw) => JSON.parse(JSON.stringify(raw));

// The audit label every heal write of a reconcile pass folds under, until the
// pass names what it changed (see `describeReconcile`).
const RECONCILE_LABEL = 'Reconcile layers on open';

// "Failed to create relation" is the error label; "Create relation" is the
// operation the audit log shows for it.
function operationLabel(errorLabel) {
  const s = String(errorLabel).replace(/^Failed to\s+/i, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export class DocumentModel {
  constructor({ raw, client = null, projectId = null, project = null, user = null, asOf = null }) {
    this._raw = raw;
    this._client = client;
    this._projectId = projectId;
    // The project (its ACL and config) and the person writing ({ id, isAdmin }),
    // for the provenance convention the subclass's `writer` reads. Null = a
    // verifier: scripts, imports, tests.
    this._project = project;
    this._user = user;
    // Which snapshot this document was read at (null = live). `_reload` reads
    // at it, so a resync during time travel stays on the snapshot instead of
    // silently jumping to live data.
    this._asOf = asOf;
    // `_version` is the subscription snapshot: it bumps on EVERY emit, including
    // the isSaving and error toggles that change no document data. Derived
    // values key on `_dataVersion` instead, which bumps only when `_raw`
    // changes, so a transient saving re-render does not rebuild a grid and
    // jitter the focused cell.
    this._version = 0;
    this._dataVersion = 0;
    this._listeners = new Set();
    this._derivedCache = new Map();
    this._isSaving = false;
    this._error = '';
    // The write queue behind `_queueWrite`: the tail every new send chains
    // onto, how many sends are waiting or in flight, and the generation a
    // failure bumps to skip the sends queued behind it.
    this._writeTail = Promise.resolve();
    this._queuedWrites = 0;
    this._writeGeneration = 0;
    this._reloadWhenDrained = false;
    // The screen's error channel, `(message, err, label)`: the label is what
    // was being done and `err` the client's error, for the screen to word.
    // Null until the screen wires it. The domain layer shows nothing itself.
    this.onError = null;
  }

  get version() {
    return this._version;
  }
  get dataVersion() {
    return this._dataVersion;
  }
  get raw() {
    return this._raw;
  }
  get id() {
    return this._raw?.id;
  }
  get name() {
    return this._raw?.name;
  }
  get client() {
    return this._client;
  }
  get projectId() {
    return this._projectId;
  }
  get project() {
    return this._project;
  }
  get asOf() {
    return this._asOf;
  }
  get isSaving() {
    return this._isSaving;
  }
  get error() {
    return this._error;
  }

  /**
   * Which way this document's data is laid out, 'ltr' or 'rtl'. What the
   * document was SET to, and otherwise what its own text says.
   *
   * Every grid in both apps takes its column order from this one value, so a
   * document reads one way throughout rather than sentence by sentence. A
   * single cell still decides for itself: see `domain/textDirection.js`.
   *
   * `body` is the subclass's, and is the baseline text in both apps.
   */
  get textDirection() {
    return this._derived('textDirection', () =>
      resolveDirection(this._raw?.metadata, this.body ?? ''),
    );
  }

  /** What the document was SET to: 'ltr', 'rtl', or 'auto' for "read the text". */
  get textDirectionSetting() {
    return readTextDirection(this._raw?.metadata);
  }

  /**
   * Set or clear the direction override. `AUTO` puts the document back to
   * following its own text.
   *
   * A PATCH of the one key under the reserved namespace, so another app
   * sharing this document keeps its own fields beside it.
   */
  async setTextDirection(value) {
    const next = value === LTR || value === RTL ? value : AUTO;
    if (this.textDirectionSetting === next) return false;
    return this._withSaving(
      'Failed to save the text direction',
      async () => {
        this._applyRawPatch((raw) => {
          raw.metadata = withTextDirection(raw.metadata, next);
        });
        await this._client.documents.patchMetadata(this.id, textDirectionOps(next));
      },
      'Set text direction',
    );
  }

  /**
   * Rename the document. Optimistic like every other update: the new name is
   * in the raw document before the round trip, so the breadcrumb and the tab
   * strip follow immediately rather than after it. Returns false when the
   * name is blank, unchanged, or the write failed.
   *
   * Here rather than in each app's document because what a document MEANS is
   * the subclass's and what it is CALLED is not: the Details screen all three
   * mount calls this one method.
   */
  async rename(name) {
    const next = (name || '').trim();
    if (!next || next === this.name) return false;
    return this._withSaving('Failed to rename document', async () => {
      this._applyRawPatch((raw) => {
        raw.name = next;
      });
      await this._client.documents.update(this.id, next);
    });
  }

  /**
   * Copy the document into the same project. NOT optimistic and not a patch of
   * this document: the copy is a different document with a server-minted id,
   * and the caller navigates to it. Resolves to `{ id, name }` for the copy,
   * or null when it failed (the screen has already been told).
   *
   * The server answers with the id alone, so the name in the result is the one
   * asked for, which is the copy's name.
   *
   * Same project only, and comments do not travel, which is the server's
   * ruling, not this method's choice.
   */
  async copyTo(name) {
    const next = (name || '').trim() || `${this.name} (copy)`;
    let created = null;
    const ok = await this._withSaving('Failed to copy document', async () => {
      created = await this._client.documents.copy(this.id, next);
    });
    return ok && created?.id ? { ...created, name: next } : null;
  }

  // ----- subscription bridge (useSyncExternalStore-compatible) -----
  // Arrow-field properties so identities stay stable across renders of the
  // same instance.
  subscribe = (listener) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getSnapshot = () => this._version;

  _emit() {
    this._version++;
    this._listeners.forEach((fn) => fn());
  }

  // Operation and validation errors go to the screen's `onError`. `_error` is
  // still tracked so callers can branch on outcome and the same sticky message
  // is not reported twice.
  setError(msg) {
    if (this._error === msg) return;
    this._error = msg;
    if (msg && this.onError) this.onError(msg);
    this._emit();
  }

  clearError() {
    if (!this._error) return;
    this._error = '';
    this._emit();
  }

  // A value derived from `_raw`, computed once per data version. Every cached
  // getter in a subclass goes through here, so nothing can be served stale
  // after a patch or a reload.
  _derived(key, compute) {
    const hit = this._derivedCache.get(key);
    if (hit && hit.version === this._dataVersion) return hit.value;
    const value = compute();
    this._derivedCache.set(key, { version: this._dataVersion, value });
    return value;
  }

  // ----- mutation infrastructure -----

  // Single-flight gate around a mutation: skip if already saving, clear the
  // error at the start, report and surface a failure, refetch the document on
  // failure. Returns true on success and false otherwise so callers can branch.
  //
  // Every mutation also runs as ONE logical operation in the audit log
  // (`client.withOperation`): however many writes or batches it makes show up
  // in the History drawer as a single expandable entry labeled `operation`
  // (derived from the "Failed to ..." error label unless given explicitly).
  // Nested mutations flatten into the outer operation.
  async _withSaving(label, fn, operation = operationLabel(label)) {
    if (this._isSaving) return false;
    if (!this._canWrite(label)) return false;
    this._isSaving = true;
    this._error = '';
    this._emit();
    try {
      await this._client.withOperation(operation, fn);
      return true;
    } catch (err) {
      await this._writeFailed(label, err);
      return false;
    } finally {
      this._isSaving = false;
      this._emit();
    }
  }

  // Whether a write may go through this document at all. A document read at
  // `asOf` is a past state: nothing writes through it. A screen that let an
  // edit reach one would otherwise write a plan made against the past into
  // the current document. Says why on the error channel when it refuses.
  _canWrite(label) {
    if (!this._asOf) return true;
    const err = new Error('An earlier state of the document cannot be edited.');
    this._error = `${label}: ${err.message}`;
    if (this.onError) this.onError(this._error, err, label);
    this._emit();
    return false;
  }

  // Report a failed write and refetch the document, which takes back whatever
  // the write had already shown.
  async _writeFailed(label, err) {
    console.error(`${label}:`, err);
    this._error = `${label}: ${err.message || 'Unknown error'}`;
    // The raw error rides along so the screen can word it (statuses, network
    // failures) while keeping the "Failed to ..." label as the title.
    if (this.onError) this.onError(this._error, err, label);
    try {
      await this._reload();
    } catch (reloadErr) {
      console.error('Reload after failure also failed:', reloadErr);
    }
  }

  // An optimistic write in two halves. The caller has already shown the edit
  // (`_canWrite`, then `_applyRawPatch`); `send` makes the server calls. Sends
  // run one at a time, in the order the edits were made, so an edit made while
  // another is in flight is on screen at once and its send waits its turn,
  // where `_withSaving` would drop it. A failed send reloads the document,
  // which takes the edits queued behind it off the screen as well, so their
  // sends are skipped. Resolves true when `send` landed, false otherwise.
  // `isSaving` holds while anything is queued.
  //
  // `reload: true` is for the one write whose effect the server works out and
  // the screen cannot replay: the document is refetched once the queue has
  // drained, not straight after the send, because a refetch then would drop
  // the edits still queued behind it from the screen.
  _queueWrite(label, send, operation = operationLabel(label), { reload = false } = {}) {
    const generation = this._writeGeneration;
    this._queuedWrites += 1;
    if (!this._isSaving) {
      this._isSaving = true;
      this._error = '';
      this._emit();
    }
    const run = async () => {
      try {
        if (generation !== this._writeGeneration) return false;
        await this._client.withOperation(operation, send);
        if (reload) this._reloadWhenDrained = true;
        return true;
      } catch (err) {
        this._writeGeneration += 1;
        this._reloadWhenDrained = false;
        await this._writeFailed(label, err);
        return false;
      } finally {
        if (this._queuedWrites === 1 && this._reloadWhenDrained) {
          this._reloadWhenDrained = false;
          try {
            await this._reload();
          } catch (err) {
            console.error('Reload after a write failed:', err);
          }
        }
        this._queuedWrites -= 1;
        if (this._queuedWrites === 0) {
          this._isSaving = false;
          this._emit();
        }
      }
    };
    const result = this._writeTail.then(run);
    this._writeTail = result.catch(() => {});
    return result;
  }

  // What a patch producer is handed beside the clone of `_raw` (a fresh layer
  // info for the clone, a mutable copy of whatever else the subclass keeps
  // beside the document), and what the subclass keeps from it once the patch
  // is in.
  _patchContext(next) {
    void next;
    return [];
  }
  _afterPatch(next, context) {
    void next;
    void context;
  }

  // Apply an optimistic local-state patch. The producer receives a deep clone
  // of `_raw` plus the subclass's context for that clone, mutates in place, and
  // the result replaces `_raw`. Emits, so every `_raw` swap goes hand in hand
  // with a version bump and a notify, which is the invariant every derived
  // value relies on.
  _applyRawPatch(producer) {
    const next = cloneRaw(this._raw);
    const context = this._patchContext(next);
    producer(next, ...context);
    this._afterPatch(next, context);
    this._raw = next;
    this._dataVersion++;
    this._emit();
  }

  // Re-read this document IN PLACE, keeping its identity. `atAsOf` returns a
  // NEW instance, which is right for time travel (the snapshot really is a
  // different document) and wrong for a refresh: an editor keyed on the
  // document's identity would be destroyed and rebuilt, and the reader would
  // lose their scroll position, the focused cell and any open popover. This
  // emits instead, which the editor repaints from. Use it whenever the
  // document the user is looking at has simply changed underneath them.
  async reload() {
    return this._reload();
  }

  // Re-fetch the raw document from the server, at this document's own
  // snapshot. Used in `_withSaving` catch paths and as the "give up and resync"
  // hook after a large multi-batch operation.
  async _reload() {
    if (!this._client || !this.id) return;
    const updated = await this._client.documents.get(this.id, true, this._asOf || undefined);
    await this._adoptReload(updated);
    this._raw = updated;
    this._dataVersion++;
    this._emit();
  }

  // Whatever the subclass keeps beside the document and has to refresh with
  // it (plaid-igt's vocabularies). Runs before the raw swap and the emit.
  async _adoptReload(updated) {
    void updated;
  }

  // This document at `asOf`, as a NEW instance: a snapshot really is a
  // different document (see useHistoryView), where `reload` is this one
  // refreshed. `this` is left untouched, so the caller keeps rendering it
  // until it swaps.
  async atAsOf(asOf) {
    const raw = await this._client.documents.get(this.id, true, asOf || undefined);
    const next = this._snapshot(raw, asOf);
    // The error handler is the screen's, not this instance's: carry it.
    next.onError = this.onError;
    return next;
  }

  // Build the instance `atAsOf` returns, from a raw document read at `asOf`.
  _snapshot(raw, asOf) {
    void raw;
    void asOf;
    throw new Error(`${this.constructor.name} does not build snapshots`);
  }

  // ----- reconcile on open -----

  // Heal what another app may have left in the shared substrate, once, when
  // the document opens (useReconcileOnOpen holds the editor behind a gate while
  // it runs). The repair is the subclass's `_reconcile`, which resolves to a
  // tally carrying `findings` (what it could not heal) and `error` (a repair
  // that failed partway). Every heal write folds under ONE audit entry,
  // relabelled by `describeReconcile` to name the repair that ran, and never
  // after a failure, since the pass may have written half of what the label
  // would claim. A pass that wrote nothing creates no group. Deliberately not
  // `_withSaving`: a failed heal must not reload and revert the freshly loaded
  // document.
  //
  // Concurrent callers (StrictMode's double invoke, a quick tab switch) share
  // ONE in-flight pass and its result. A bare single-flight gate handed the
  // second caller an empty result, which is what the screen reported, so
  // integrity findings were never shown in dev.
  async reconcileOnOpen() {
    if (this._reconcilePromise) return this._reconcilePromise;
    this._reconcilePromise = this._client
      .withOperation(RECONCILE_LABEL, async (setMessage) => {
        const result = await this._reconcile();
        if (!result.error) {
          const refined = this.describeReconcile(result);
          if (refined) setMessage(refined);
        }
        return result;
      })
      .finally(() => {
        this._reconcilePromise = null;
      });
    return this._reconcilePromise;
  }

  // The repair itself: what this document's invariants are and how to heal
  // them. Resolves to the tally `reconcileOnOpen` describes.
  async _reconcile() {
    return { findings: [] };
  }

  // One line naming what a repair changed, or null when it wrote nothing. The
  // audit entry's label, and the console's record of the pass.
  describeReconcile(result) {
    void result;
    return null;
  }
}
