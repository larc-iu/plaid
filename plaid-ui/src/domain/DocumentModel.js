// The lifecycle every editable document shares, whichever app's linguistics sit
// on top: the raw document and who is writing it, a subscription a React hook
// or a vanilla island can follow, the write queue (WriteQueue.js) that runs
// each mutation as one logical operation in the order it was made and resyncs
// on failure, the optimistic raw patch, reload in place, and the snapshot
// beside the live document. What a document MEANS (its layers, rows, and every
// mutation) is the subclass's.
//
// Imports three siblings with no imports of their own, and lib/errors.js, which
// has none either, and nothing else: plaid-ud's node suite reaches this file by
// relative path, where no alias and no package resolves. Errors leave through
// `onError`.

import { statusOf } from '../lib/errors.js';
import {
  AUTO,
  LTR,
  RTL,
  readTextDirection,
  resolveDirection,
  textDirectionOps,
  withTextDirection,
} from './textDirection.js';
import { WriteQueue } from './WriteQueue.js';
import { recordSettled, settleIds } from './pendingIds.js';

const cloneRaw = (raw) => JSON.parse(JSON.stringify(raw));

// The audit label every heal write of a reconcile pass folds under, until the
// pass names what it changed (see `describeReconcile`).
const RECONCILE_LABEL = 'Repair on open';
// The label a pass that failed partway ends with: what it wrote is only part
// of any repair a fuller label would name.
const RECONCILE_INTERRUPTED_LABEL = 'Repair on open (interrupted)';

// What an edit planned on an out-of-date document is refused with, unsent: the
// conflict the edit before it met, so every screen words it the same way.
const conflictError = () =>
  Object.assign(new Error('HTTP 409 The document has changed since this edit was made.'), {
    status: 409,
  });

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
    this._error = '';
    this._errorCause = null;
    // The queue behind `_queueWrite`. A write starting clears the last error.
    this._writes = new WriteQueue({
      onSavingChange: (saving) => {
        if (saving) this._error = '';
        this._emit();
      },
      reloadDrained: () => this._reloadDrained(),
      onOutOfStep: (err) => this._reportOutOfStep(err),
      onOfflineChange: () => this._emit(),
    });
    // The patches an edit showed, until its send starts (`_queueWrite`), so a
    // refetch can show them again on top of what it read (`_showUnsent`).
    // `_patches` holds the ones applied since the last write was queued. A
    // patch no write claims in the same turn (a send settling its ids) is
    // dropped, since what it shows is on the server already.
    this._patches = [];
    this._unsent = [];
    // How many screens show this document right now (`hold`).
    this._holds = 0;
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
    return this._writes.isSaving;
  }
  // True while a refetch after a refused edit waits for the server to be
  // reachable again. The save-status pills say "Offline, retrying".
  get isOffline() {
    return this._writes.isOffline;
  }
  get error() {
    return this._error;
  }
  // The client's error behind `error` when a write failed, for a screen that
  // words it: a lost answer to a write reads differently from a server that
  // could not be reached, and only the error object says which.
  get errorCause() {
    return this._error ? this._errorCause : null;
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
    const label = 'Failed to save the text direction';
    if (!this._canWrite(label)) return false;
    this._applyRawPatch((raw) => {
      raw.metadata = withTextDirection(raw.metadata, next);
    });
    return this._queueWrite(
      label,
      () => this._client.documents.patchMetadata(this.id, textDirectionOps(next)),
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
    const next = this._planRename(name);
    if (!next) return false;
    const label = 'Failed to rename document';
    if (!this._canWrite(label)) return false;
    this._applyRawPatch((raw) => {
      raw.name = next;
    });
    return this._queueWrite(label, () => this._client.documents.update(this.id, next));
  }

  // The name a rename to `name` writes: trimmed, or null when there is nothing
  // to write because it is blank or already the name. Every writer of a
  // document's name asks this (igt's Details save writes the name beside its
  // fields).
  _planRename(name) {
    const next = (name || '').trim();
    return next && next !== this.name ? next : null;
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
   *
   * It takes its turn in the write queue, so the copy holds every edit made
   * before it. It shows nothing, so a failure takes nothing back.
   */
  async copyTo(name) {
    const next = (name || '').trim() || `${this.name} (copy)`;
    let created = null;
    const ok = await this._queueWrite(
      'Failed to copy document',
      async () => {
        created = await this._client.documents.copy(this.id, next);
      },
      undefined,
      { shown: false },
    );
    return ok && created?.id ? { ...created, name: next } : null;
  }

  /**
   * Hold this document while a screen shows it. Returns the release.
   *
   * Once no screen holds it, a refetch has nothing left to put right: the
   * queue still sends what it holds (useSavingGuard keeps the close-tab
   * question on until it has), but a refetch after a refusal stops, even one
   * retrying while offline, so the question does not stay on with nothing
   * left to lose.
   *
   * The release takes effect a moment later, so a screen that lets go and
   * holds again at once (StrictMode, a remount) is not let go at all. Held
   * again after a refetch was left undone, the document refetches.
   */
  hold() {
    this._holds += 1;
    if (this._writes.hold()) {
      this._reload().catch((err) => console.error('Reload on coming back failed:', err));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._holds -= 1;
      setTimeout(() => {
        if (this._holds === 0) this._writes.letGo();
      }, 0);
    };
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
    this._errorCause = null;
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

  // Whether a write may go through this document at all. A document read at
  // `asOf` is a past state: nothing writes through it. A screen that let an
  // edit reach one would otherwise write a plan made against the past into
  // the current document. Says why on the error channel when it refuses.
  _canWrite(label) {
    if (!this._asOf) return true;
    const err = new Error('An earlier state of the document cannot be edited.');
    this._error = `${label}: ${err.message}`;
    this._errorCause = err;
    if (this.onError) this.onError(this._error, err, label);
    this._emit();
    return false;
  }

  // Report a failed write. The queue then refetches the document, which takes
  // back whatever the write had shown (`_reloadAfterFailure`).
  _writeFailed(label, err) {
    console.error(`${label}:`, err);
    this._error = `${label}: ${err.message || 'Unknown error'}`;
    this._errorCause = err;
    // The raw error rides along so the screen can word it (statuses, network
    // failures) while keeping the "Failed to ..." label as the title.
    if (this.onError) this.onError(this._error, err, label);
  }

  // A refetch was given up (WriteQueue's `onOutOfStep`): the server failed it
  // time after time, for a reason other than the network. The screen still
  // shows what was typed, and may show what the server does not have.
  _reportOutOfStep(err) {
    console.error('The document could not be refetched:', err);
    if (this.onError) this.onError('Reload the page to see what is saved.', null, 'Out of date');
  }

  // An optimistic write in two halves. The caller has already shown the edit
  // (`_canWrite`, then `_applyRawPatch`); `send` makes the server calls, in
  // its turn in the write queue (WriteQueue.js, which says what becomes of the
  // edits made on top of a refused one). A refused send reloads the document,
  // and a reload that fails is tried again until it lands, `isSaving` held
  // all the while, since until then the screen shows what the server lacks.
  // Resolves true when `send` landed, false otherwise. `isSaving` holds while
  // anything is queued.
  //
  // `reload: true` is for the one write whose effect the server works out and
  // the screen cannot replay: the document is refetched once the queue has
  // drained, not straight after the send, because a refetch then would drop
  // the edits still queued behind it from the screen. A send that needs the
  // server's state to go on calls `_reloadInSend` instead.
  //
  // `shown: false` is for a write that put nothing on screen (a copy).
  //
  // `kind` and `ref` go to the write's operation (see the client's
  // beginOperation), for a write that is a kind of operation a reader of the
  // audit log counts, such as igt's guess adoption.
  //
  // Every write goes through here, one at a time, so nothing is ever sent
  // beside a send or a refetch: a rename made while an edit is saving is sent
  // after it, and a copy holds the edits made before it.
  _queueWrite(
    label,
    send,
    operation = operationLabel(label),
    { reload = false, shown = true, kind, ref } = {},
  ) {
    // A caller that patches first has asked `_canWrite` already. One whose
    // send does all its work is refused here instead.
    const unsent = { patches: this._patches, stale: false };
    this._patches = [];
    if (!this._canWrite(label)) return Promise.resolve(false);
    this._unsent.push(unsent);
    let conflict = false;
    return this._writes.push(
      async () => {
        this._unsent = this._unsent.filter((u) => u !== unsent);
        // Planned on a document that turned out to have changed elsewhere
        // (`_reloadAfterFailure`): refused like the edit that found it out,
        // without being sent, and already off the screen.
        if (unsent.stale) throw conflictError();
        await this._client.withOperation(operation, send, { kind, ref });
        if (reload) this._writes.reloadWhenDrained = true;
      },
      {
        shown,
        refused: (err) => {
          conflict = statusOf(err) === 409;
          this._writeFailed(label, err);
        },
        resync: () => (unsent.stale ? undefined : this._reloadAfterFailure(conflict)),
      },
    );
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
    this._raw = this._patched(this._raw, producer);
    this._dataVersion++;
    this._emit();
    if (this._patches.length === 0) {
      queueMicrotask(() => {
        this._patches = [];
      });
    }
    this._patches.push(producer);
  }

  // `raw` with `producer` applied to a clone of it.
  _patched(raw, producer) {
    const next = cloneRaw(raw);
    const context = this._patchContext(next);
    producer(next, ...context);
    this._afterPatch(next, context);
    return next;
  }

  // Put `updated`, just read from the server, on screen with the edits still
  // waiting to be sent shown on top of it, each as it was shown when it was
  // made. A patch that no longer applies (it named something the refetch
  // does not hold) is left out: its send is refused in turn, or the refetch
  // once the queue has drained shows what landed.
  _showUnsent(updated) {
    let raw = updated;
    for (const { patches } of this._unsent) {
      for (const producer of patches) {
        try {
          raw = this._patched(raw, producer);
        } catch (err) {
          console.error('An edit waiting to be sent could not be shown again:', err);
        }
      }
    }
    this._swapRaw(raw);
  }

  // Put the server's ids in place of the pending ones an edit showed
  // (pendingIds.js), given as a map of pending id to server id. A pending id
  // the server gave no id for keeps its row as shown: a later reload puts the
  // server's state on screen, where an undefined id would break every lookup
  // until then.
  _settle(ids) {
    const known = new Map([...ids].filter(([, server]) => server));
    if (known.size === 0) return;
    recordSettled(known);
    this._applyRawPatch((next, ...context) => {
      settleIds(next, known);
      this._settleBeside(context, known);
    });
  }

  // What the subclass keeps beside the document and has to settle with it,
  // handed the context `_patchContext` made for this patch (plaid-igt's
  // vocabularies, whose links name tokens).
  _settleBeside(context, ids) {
    void context;
    void ids;
  }

  // Resolves once every edit queued so far has been sent. For an action with
  // an operation of its own (a service run): the client holds one open
  // operation, and each queued edit holds one while it saves, so an operation
  // opened before they land would join the edit's. Never call it from inside
  // a send, which the queue is waiting on.
  whenSaved() {
    return this._writes.whenIdle();
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
  // snapshot, and put it on screen in place of whatever was there.
  //
  // What the fetch cannot hold is an edit the server has not had yet, and the
  // screen must never show one thing while the server gets another. Which
  // refetch keeps that depends on where it is made, and the caller says so by
  // which of these it calls, never by what else happens to be running:
  //
  // - `_reload` (and `reload`), from OUTSIDE the write queue: a service run, a
  //   restore, reconcile, the assistant. It waits for the queue to
  //   drain, and fetches again when an edit was made while the fetch was on
  //   the wire, so every edit lands on the server and stays on screen. Never
  //   call it from inside a send, which the queue is waiting on.
  // - `_reloadInSend`, from inside a send that needs the server's state to go
  //   on (an upload, a baseline edit, a re-analyze between its phases).
  // - `_reloadAfterFailure` and `_reloadDrained`, the queue's own.
  async _reload() {
    if (!this._client || !this.id) return;
    const writes = this._writes;
    for (;;) {
      await writes.whenIdle();
      const seen = this._dataVersion;
      const pushes = writes.pushes;
      const edited = () => this._dataVersion !== seen || writes.pushes !== pushes;
      const updated = await this._fetch();
      if (edited()) continue;
      await this._adoptReload(updated);
      if (edited()) continue;
      this._swapRaw(updated);
      return;
    }
  }

  // From inside a send. The edits queued behind it are not on the server yet,
  // so they are shown again on top of what the refetch read, and a refetch
  // once the queue has drained puts the screen in step with the server.
  async _reloadInSend() {
    if (!this._client || !this.id) return;
    const updated = await this._fetch();
    await this._adoptReload(updated);
    this._showUnsent(updated);
    if (this._writes.queued > 1) this._writes.reloadWhenDrained = true;
  }

  // After a refused send. The refetch takes the refused edit off the screen.
  // The edits queued behind it (an edit made while this fetch was on the wire
  // included) stay on screen and are still sent, and `_reloadDrained` shows
  // what landed once they have. A failure throws, and the queue tries again.
  //
  // After a conflict (409) in strict mode, those edits were planned on the
  // same out-of-date document. Sent now, they would carry the version this
  // fetch has just learned, get past the check that refused the first, and
  // could make a second value where someone else has made one. They are
  // refused as well, without being sent, and taken off the screen with it.
  async _reloadAfterFailure(conflict = false) {
    if (!this._client || !this.id) return;
    const updated = await this._fetch();
    await this._adoptReload(updated);
    if (conflict && this._client.strictModeDocumentId === this.id) {
      this._unsent.forEach((u) => {
        u.stale = true;
      });
      this._unsent = [];
      this._swapRaw(updated);
      return;
    }
    this._showUnsent(updated);
  }

  // The last send has landed and one before it asked for the server's view.
  // An edit made while this fetch was on the wire is queued behind it, so the
  // fetch is not put on screen: that edit's own send refetches once it lands.
  async _reloadDrained() {
    if (!this._client || !this.id) return;
    const writes = this._writes;
    writes.reloadWhenDrained = false;
    const seen = this._dataVersion;
    const updated = await this._fetch();
    const edited = () => this._dataVersion !== seen || writes.queued > 1;
    if (!edited()) await this._adoptReload(updated);
    if (edited()) {
      writes.reloadWhenDrained = true;
      return;
    }
    this._swapRaw(updated);
  }

  _fetch() {
    return this._client.documents.get(this.id, true, this._asOf || undefined);
  }

  _swapRaw(updated) {
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
  // tally carrying `findings` (what it could not heal), and `error` or
  // `interrupted` for a repair that failed partway. Every heal write folds
  // under ONE audit entry, relabelled by `describeReconcile` to name the
  // repair that ran. A subclass may put that label on before its first write
  // (UMR does, so a batch sent as several requests carries it from the
  // first). A pass that failed partway ends as RECONCILE_INTERRUPTED_LABEL
  // whatever it started with, since it may have written only part of what a
  // fuller label would claim. A pass that wrote nothing creates no group.
  // Deliberately not a queued write: a failed heal must not reload and revert
  // the freshly loaded document. The operation is of kind `repair`, so a
  // reader of the audit log can tell these writes from a person's.
  //
  // Concurrent callers (StrictMode's double invoke, a quick tab switch) share
  // ONE in-flight pass and its result, so the second caller reports the same
  // findings as the first.
  async reconcileOnOpen() {
    if (this._reconcilePromise) return this._reconcilePromise;
    this._reconcilePromise = this._client
      .withOperation(
        RECONCILE_LABEL,
        async (setMessage) => {
          const result = await this._reconcile();
          if (result.error || result.interrupted) {
            setMessage(RECONCILE_INTERRUPTED_LABEL);
          } else {
            const refined = this.describeReconcile(result);
            if (refined) setMessage(refined);
          }
          return result;
        },
        { kind: 'repair' },
      )
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
