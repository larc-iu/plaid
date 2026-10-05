// The lifecycle every editable document shares, whichever app's linguistics sit
// on top: the raw document and who is writing it, a subscription a React hook
// or a vanilla island can follow, the write queue (WriteQueue.js) that runs
// each mutation as one logical operation in the order it was made and resyncs
// on failure, the optimistic raw patch, reload in place, and the snapshot
// beside the live document. What a document MEANS (its layers, rows, and every
// mutation) is the subclass's.
//
// Imports siblings with no imports but each other's and lib/errors.js,
// which has none, and nothing else: plaid-ud's node suite reaches this file by
// relative path, where no alias and no package resolves. Errors leave through
// `onError`.

import { isChangedElsewhere, isIdTaken, isUnknownOutcome, statusOf } from '../lib/errors.js';
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
import { newId, recordSettled, settleIds } from './pendingIds.js';
import { sameConfig } from './configCells.js';
import { DOCUMENT_DELETED, asDeletedDocument } from './permissions.js';
import { createdIdsOf, footprintOf, namesAnyOf, pendingIdsOf, resendable } from './rebase.js';

// A copy of a document read from the server, which is plain JSON. A walk
// rather than a JSON round trip, which took five times as long on a document
// of 40k words, on every edit (H2-IGT-ANALYZE-3). An undefined field is left
// out, as JSON leaves it out.
const cloneRaw = (value) => {
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) out[i] = cloneRaw(value[i]);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      const v = value[key];
      if (v === undefined) continue;
      // An own `__proto__` key (JSON.parse makes one) would set the copy's
      // prototype by assignment.
      if (key === '__proto__') {
        Object.defineProperty(out, key, {
          value: cloneRaw(v),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else out[key] = cloneRaw(v);
    }
    return out;
  }
  return value;
};

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

// What an edit that names a row made by a refused edit is refused with,
// unsent: the server would refuse the id it names, which it never made.
// lib/errors.js words it by this message.
const dependencyError = () =>
  Object.assign(new Error('HTTP 400 The edit this one depends on was not saved.'), {
    status: 400,
  });

// What every edit is refused with once the document is known to be deleted
// (`_documentGone`), unsent. `deleted` lets the screen tell it from a refusal
// the server made.
const DELETED = 'This document was deleted.';
const deletedError = () => Object.assign(new Error(DELETED), { deleted: true });

// Whether a read of the document was refused because it is gone: 404, or the
// core's 403 for an id it cannot place in a project (`unresolved`, the
// ruling on unknown ids).
const isDocumentGone = (err) =>
  statusOf(err) === 404 || (statusOf(err) === 403 && err?.responseData?.unresolved === true);

// How many waiting edits keep the document they were made on, for telling
// whether a change elsewhere touched them (rebase.js). One past that is
// treated as touched: a long offline queue must not hold a copy of the
// document per edit.
const KEEP_BASES = 16;

// "Failed to create relation" is the error label; "Create relation" is the
// operation the audit log shows for it, unless the screen named it (`labelled`).
function operationLabel(errorLabel) {
  const s = String(errorLabel).replace(/^Failed to\s+/i, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// What the document says while an edit waits for someone else's lock on it
// to go (WriteQueue `resendWhileLocked`). Not "try again": it goes again
// by itself.
export const LOCKED_WAITING =
  'This document is being edited right now (by another user or a service). Saving once it is free.';

// A refusal for someone else's lock on the document, which goes again by
// itself. Not the client's own lock lapsing (DocumentLockLost).
const isLockedByOther = (err) => statusOf(err) === 423 && err?.name !== 'DocumentLockLost';

// How often a document a screen holds reads its project again.
const PROJECT_READ_EVERY_MS = 60_000;

const ROLE_LISTS = ['maintainers', 'writers', 'readers'];

// The project with `userId` in none of its role lists.
const withoutMember = (project, userId) => {
  const next = { ...project };
  for (const key of ROLE_LISTS) {
    if (Array.isArray(project[key])) next[key] = project[key].filter((id) => id !== userId);
  }
  return next;
};

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
    // A refusal whose conflict the screen reports itself (`handlesConflicts`):
    // `errorCause` still gives it, `error` says nothing.
    this._handledCause = null;
    // The queue behind `_queueWrite`. A write starting clears the last error.
    this._writes = new WriteQueue({
      onSavingChange: (saving) => {
        if (saving) {
          this._error = '';
          this._handledCause = null;
        }
        this._emit();
      },
      reloadDrained: () => this._reloadDrained(),
      onOutOfStep: (err) => this._reportOutOfStep(err),
      onOfflineChange: () => this._emit(),
      // An edit waiting out another's lock says so where a refusal would,
      // and stops saying so once it is sent. A new data version too, since a
      // screen that draws `error` with its data (igt's grid) draws only then.
      onLockedChange: (locked) => {
        if (locked) {
          this._error = LOCKED_WAITING;
          this._errorCause = null;
        } else if (this._error === LOCKED_WAITING) {
          this._error = '';
        }
        this._lockChanges++;
        this._emit();
      },
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
    // How many times a read of the project changed it (`refreshProject`).
    this._projectReads = 0;
    // How often an edit started or stopped waiting out another's lock
    // (`onLockedChange`), which moves `dataVersion` too.
    this._lockChanges = 0;
    // The History label a screen gave the writes it is making (`labelled`).
    this._operation = null;
    this._conflictHandled = false;
    this._byEntity = false;
    // The writes a `cellWrite` queues, each with its refusal once it has one.
    this._cellScope = null;
    // The document before the first patch of the edit being made, until its
    // write is queued (`_queueWrite`), and whether any of its patches changed
    // what the subclass keeps beside the document (`_changesBeside`).
    this._patchBase = null;
    this._patchesBeside = false;
    // The pending ids of rows made by edits that were refused: the server
    // never made them, and an edit that names one is refused unsent.
    this._refusedIds = new Set();
    // Whether a read of the document found it deleted (`_documentGone`).
    this._deleted = false;
    // The screen's error channel, `(message, err, label)`: the label is what
    // was being done and `err` the client's error, for the screen to word.
    // Null until the screen wires it. The domain layer shows nothing itself.
    this.onError = null;
  }

  get version() {
    return this._version;
  }
  /** The document's data version, which a new copy of the project also moves. */
  get dataVersion() {
    return this._dataVersion + this._projectReads + this._lockChanges;
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
  /** True once a read of the document found it deleted. Nothing writes through it then. */
  get deleted() {
    return this._deleted;
  }
  get isSaving() {
    return this._writes.isSaving;
  }
  // True while the document holds text the server refused and the reader has
  // not yet dismissed, which a reload would lose. A subclass that keeps such
  // text says so. A reload or a closed tab asks first (`useSavingGuard`).
  get holdsUnsaved() {
    return false;
  }
  // True while a refetch after a refused edit waits for the server to be
  // reachable again. The save-status pills say "Offline, retrying".
  get isOffline() {
    return this._writes.isOffline;
  }
  // True while an edit waits for someone else's lock on the document to go,
  // to be sent once it has. `error` is LOCKED_WAITING meanwhile.
  get isLocked() {
    return this._writes.isLocked;
  }
  // True once a refetch after a refused edit was given up (the server failed
  // it time after time), until a later one lands: what the screen shows may
  // not be what the server has. WriteQueue's `outOfStep`.
  get outOfStep() {
    return this._writes.outOfStep;
  }
  get error() {
    return this._error;
  }
  // The client's error behind `error` when a write failed, for a screen that
  // words it: a lost answer to a write reads differently from a server that
  // could not be reached, and only the error object says which.
  get errorCause() {
    return this._error ? this._errorCause : this._handledCause;
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
      // No label: the copy's History then shows the server's description,
      // `Copy "<source>" as "<name>"`, where a label would say only "Copy
      // document".
      null,
      { shown: false },
    );
    return ok && created?.id ? { ...created, name: next } : null;
  }

  /**
   * Hold this document while a screen shows it. Returns the release.
   *
   * Once no screen holds it, a refetch has nothing left to put right: a
   * refetch after a refusal stops, even one retrying while offline. What the
   * queue holds is still sent, a send waiting for the network included, for
   * as long as the page is open, and useSavingGuard keeps the close-tab
   * question on until it has landed.
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
    if (this._holds === 1) this._watchProject();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._holds -= 1;
      if (this._holds === 0) this._unwatchProject?.();
      setTimeout(() => {
        if (this._holds !== 0) return;
        this._writes.letGo();
      }, 0);
    };
  }

  // While a screen holds the document, its project is read again on a return
  // to the tab and every minute on a visible tab: whose work is reviewed
  // (`plaid.review`) decides what every next edit and approval is stamped
  // with, and an app's settings (a closed tagset) what a cell takes
  // (H11-MULTI-2).
  _watchProject() {
    if (typeof document === 'undefined' || this._unwatchProject) return;
    const read = () => {
      if (document.visibilityState === 'visible') this.refreshProject();
    };
    document.addEventListener('visibilitychange', read);
    const timer = setInterval(read, PROJECT_READ_EVERY_MS);
    this._unwatchProject = () => {
      document.removeEventListener('visibilitychange', read);
      clearInterval(timer);
      this._unwatchProject = null;
    };
  }

  /**
   * Read the project again (see `_watchProject`; every refetch reads it too).
   * A past state keeps the project it has, since a project has no past state.
   * Quiet on failure: the copy stays as it was. Answers whether it changed.
   */
  async refreshProject() {
    return this._takeProject(await this._readProject());
  }

  /**
   * Keep a new copy of the project, wherever it was read (`refreshProject`, a
   * subclass's `_adoptReload`), and tell the screen: who may write is read off
   * it, so a member demoted while the page is open gets the read-only page at
   * once. Answers whether it changed.
   */
  _takeProject(project) {
    // A deleted document keeps its project marked so (permissions.js), so
    // every screen over it is read-only for everyone, an admin included,
    // and says why, whatever a later read of the project says.
    if (project && this._deleted) project = asDeletedDocument(project);
    if (!project) return false;
    const marked = !!project[DOCUMENT_DELETED] === !!this._project?.[DOCUMENT_DELETED];
    if (marked && sameConfig(project, this._project)) return false;
    this._project = project;
    this._adoptProject(project);
    // A new data version, so what is derived from the project is derived
    // again. `_dataVersion` itself is left alone, since a reload takes a bump
    // of it during its fetch for an edit and would then not show what it
    // fetched.
    this._projectReads++;
    this._derivedCache.clear();
    this._emit();
    return true;
  }

  // The project as the server has it now. Refused outright (403) means this
  // person holds no role in it any more (an admin reads every project), so
  // the copy kept is the one they hold no role in. Any other failure keeps
  // the copy as it was.
  async _readProject() {
    if (!this._client?.projects?.get || !this._projectId || this._asOf) return null;
    try {
      return await this._client.projects.get(this._projectId);
    } catch (err) {
      if (statusOf(err) === 403 && this._project && this._user?.id) {
        return withoutMember(this._project, this._user.id);
      }
      console.warn('Could not read the project again:', err);
      return null;
    }
  }

  // What the subclass takes from a new copy of the project, beside keeping it.
  _adoptProject(project) {
    void project;
  }

  /**
   * Run `fn`, and give every write it queues `operation` as its History
   * label, in place of the one the mutation names itself. For a screen that
   * knows what the edit means to the person making it ("Gloss of dogs in
   * sentence 3: DOG") where the mutation knows only its field ("Update
   * Gloss"). Only the writes queued before `fn` first awaits are labelled,
   * which is every mutation's own write. Returns what `fn` returns.
   */
  labelled(operation, fn) {
    const outer = this._operation;
    this._operation = operation || outer;
    try {
      return fn();
    } finally {
      this._operation = outer;
    }
  }

  /**
   * Run `fn`, whose writes are made by a screen that shows a conflict itself
   * (a cell that keeps the other user's value with the typed one under it).
   * When one of them is refused for a conflict (409), `onError` is not called
   * and `error` stays empty, so no second toast or banner contradicts it.
   * `errorCause` still gives the refusal. The same scope as `labelled`.
   * Returns what `fn` returns.
   */
  handlesConflicts(fn) {
    const outer = this._conflictHandled;
    this._conflictHandled = true;
    try {
      return fn();
    } finally {
      this._conflictHandled = outer;
    }
  }

  /**
   * Run `fn`, a grid cell's write, inside `handlesConflicts`, and answer what
   * became of it: `{ landed: true, value }`, where `value` is what `fn`
   * answered, or `{ landed: false, status, error, readBack }`.
   * `error` is the refusal of a write `fn` queued, its own and not a later
   * write's. `readBack` says the document was read again after the refusal,
   * so what it holds is what the server holds. A write whose answer was lost
   * is sent again until it is answered (`resendWhenBack`), so it never ends
   * here unknown. The cell engine
   * (cells/CellEngine.js) takes it from here.
   */
  cellWrite(fn) {
    const outer = this._cellScope;
    const scope = [];
    this._cellScope = scope;
    let answer;
    try {
      answer = this.handlesConflicts(fn);
    } finally {
      this._cellScope = outer;
    }
    return Promise.resolve(answer).then((value) => {
      const failed = scope.find((w) => w.error);
      if (value !== false && !failed) return { landed: true, value };
      const error = failed?.error ?? null;
      return {
        landed: false,
        status: statusOf(error) ?? null,
        error,
        readBack: !this.outOfStep,
      };
    });
  }

  /**
   * Run `fn`, whose writes are values on a token that leave its extent as it
   * is (igt's glosses), and opt them in to the rule by entity when one is
   * refused because the document moved on: it goes again by itself when
   * nothing that changed touches what it writes, a change in its own layer
   * included (rebase.js `untouched`). Every other write goes again only when
   * what changed is all in layers it neither reads nor writes (`apart`). A
   * write in the scope that moves a token or the text gets the rule by layer
   * all the same. The same scope as `labelled`. Returns what `fn` returns.
   */
  resendsByEntity(fn) {
    const outer = this._byEntity;
    this._byEntity = true;
    try {
      return fn();
    } finally {
      this._byEntity = outer;
    }
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
    if (!this._asOf && !this._deleted) return true;
    const err = this._deleted
      ? deletedError()
      : new Error('An earlier state of the document cannot be edited.');
    this._error = `${label}: ${err.message}`;
    this._errorCause = err;
    if (this.onError) this.onError(this._error, err, label);
    this._emit();
    return false;
  }

  // Report a failed write. The queue then refetches the document, which takes
  // back whatever the write had shown (`_reloadAfterFailure`).
  //
  // `handled` is a conflict the screen reports itself (`handlesConflicts`).
  _writeFailed(label, err, handled = false) {
    console.error(`${label}:`, err);
    // Held back unsent once the document was found deleted, which was said
    // once already (`_documentGone`).
    if (err?.deleted) {
      this._handledCause = null;
      this._error = `${label}: ${err.message}`;
      this._errorCause = err;
      return;
    }
    if (handled) {
      this._error = '';
      this._handledCause = err;
      return;
    }
    this._handledCause = null;
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
  // `recheck(fresh)` is for an edit the screen checked against the rest of
  // the document before making it (no cycle, both ends there). When the edit
  // is to go on a newer version than it was made on (a refusal and a read
  // since, see `_afterConflict`), it is asked again, on that version before
  // the edit: `fresh` is a document of the subclass's own kind (`_snapshot`)
  // over what was read, with the edits ahead of it shown. False refuses the
  // edit like a conflict. Without one, only what changed in between is
  // looked at (rebase.js): by layer, or by entity for a write made inside
  // `resendsByEntity`.
  //
  // Every write goes through here, one at a time, so nothing is ever sent
  // beside a send or a refetch: a rename made while an edit is saving is sent
  // after it, and a copy holds the edits made before it.
  //
  // An edit whose answer was lost (no response, 502, 504) is sent again until
  // the server answers (WriteQueue's `resendWhenBack`). Every attempt runs
  // under the same operation id and the same Idempotency-Key seed (the
  // client's `keySeed`), so the requests of the first attempt that landed
  // are answered from what they stored and write nothing twice, and the rest
  // run. The rebase resend after a real conflict is a new write on a new
  // version, and takes a new seed.
  _queueWrite(
    label,
    send,
    named = operationLabel(label),
    { reload = false, shown = true, kind, ref, recheck = null } = {},
  ) {
    const operation = this._operation || named;
    const conflictHandled = this._conflictHandled;
    // A caller that patches first has asked `_canWrite` already. One whose
    // send does all its work is refused here instead.
    const kept = this._unsent.filter((u) => u.base).length;
    const unsent = {
      patches: this._patches,
      stale: false,
      // The document the edit was made on and the one it made, for what it
      // touches (`_untouched`), whether it did so on the server already
      // (`_afterConflict`), and the pending ids it makes and names
      // (`_summary`).
      base: this._patches.length && kept < KEEP_BASES ? this._patchBase : null,
      made: null,
      origin: null,
      footprint: undefined,
      ids: undefined,
      created: undefined,
      // It changed what the subclass keeps beside the document (igt's
      // links), which no read of the document shows: never sent again.
      beside: this._patchesBeside,
      recheck,
      // Opted in to the rule by entity (`resendsByEntity`).
      byEntity: this._byEntity,
      // The logical operation every attempt of it joins, and the seed of
      // their Idempotency-Keys.
      groupId: newId(),
      keys: this._client?.keySeed?.() ?? null,
    };
    if (unsent.base) unsent.made = this._raw;
    this._patches = [];
    this._patchBase = null;
    this._patchesBeside = false;
    if (!this._canWrite(label)) return Promise.resolve(false);
    const cell = this._cellScope ? { error: null } : null;
    this._cellScope?.push(cell);
    this._unsent.push(unsent);
    let conflict = false;
    const run = () =>
      this._client.withOperation(operation, send, {
        kind,
        ref,
        groupId: unsent.groupId,
        keys: unsent.keys,
        // A create refused 409 id-taken for a row this edit made was made by
        // an earlier send of it, and answers as made (the client).
        minted: this._created(unsent),
      });
    return this._writes.push(
      async () => {
        this._unsent = this._unsent.filter((u) => u !== unsent);
        // The document was found deleted since it was queued.
        if (this._deleted) throw deletedError();
        // Planned on a document that turned out to have changed elsewhere
        // (`_reloadAfterFailure`): refused like the edit that found it out,
        // without being sent, and already off the screen.
        if (unsent.stale) throw conflictError();
        // It names a row an edit before it made, and that edit was refused.
        if (this._namesRefused(unsent)) throw dependencyError();
        const before = this._checkedVersion();
        try {
          await run();
        } catch (err) {
          // Refused because the document moved on, with none of it written:
          // when what changed does not touch it, it goes again, once, on the
          // new version, as a new write.
          const nothingLanded = before != null && this._checkedVersion() === before;
          const next =
            statusOf(err) === 409 && nothingLanded ? await this._afterConflict(unsent) : null;
          if (next !== 'resend') throw err;
          unsent.keys = this._client?.keySeed?.() ?? null;
          await run();
        }
        if (reload) this._writes.reloadWhenDrained = true;
      },
      {
        shown,
        resendWhenBack: (err) => isUnknownOutcome(err),
        resendWhileLocked: isLockedByOther,
        refused: (err) => {
          // A conflict, or what the edit names was deleted meanwhile: either
          // way someone else changed the document.
          conflict = isChangedElsewhere(err);
          if (cell) cell.error = err;
          const created = this._created(unsent) ?? new Set();
          // Refused because a row it makes is there already under the id this
          // page minted, inside a batch the refusal took back whole: that row
          // is made, and the rest of the edit is not. One deleted since is not.
          const made = isIdTaken(err) && !err.responseData?.deleted ? err.responseData?.id : null;
          if (made && created.has(made)) recordSettled([[made, made]]);
          // The rows it made are not on the server otherwise.
          for (const id of created) if (id !== made) this._refusedIds.add(id);
          // Refused for a missing permission: whoever changed this person's
          // role, the page is put in step with it now rather than within the
          // minute (a reader's page offers nothing to edit).
          if (statusOf(err) === 403 && !this._deleted) this.refreshProject();
          this._writeFailed(label, err, conflictHandled && statusOf(err) === 409);
        },
        resync: () =>
          unsent.stale || this._deleted ? undefined : this._reloadAfterFailure(conflict),
      },
    );
  }

  // After a refusal for a changed document: read it.
  // - When nothing that changed touches it (rebase.js) and its `recheck`
  //   holds, show it again on top of what was read, with the edits waiting
  //   behind it, and answer 'resend' so it is sent again.
  // - Otherwise null, leaving everything as it was, for the refusal to take
  //   its course.
  async _afterConflict(unsent) {
    if (!unsent.base || unsent.beside) return null;
    let updated;
    try {
      updated = await this._fetch();
    } catch (err) {
      console.error('Reading the document after a refusal failed:', err);
      return null;
    }
    if (!this._untouched(unsent, updated)) return null;
    // What the subclass keeps beside the document is read again first, so
    // the edit is shown again on top of it, as `_showUnsent` does.
    await this._adoptReload(updated);
    if (!this._recheck(unsent, updated)) return null;
    let shown = updated;
    try {
      for (const producer of unsent.patches) shown = this._patched(shown, producer);
    } catch (err) {
      console.error('A refused edit could not be shown again:', err);
      return null;
    }
    // The edits waiting behind it were made on the old version as well, and
    // go after it on this one: each is checked as it was.
    this._keepUntouched(shown);
    this._showUnsent(shown, { recheck: true });
    return 'resend';
  }

  // Keeps waiting only the edits that nothing changed between the document
  // each was checked against and `now` touches (rebase.js). The rest are
  // refused like a conflict when their turn comes, without being sent.
  _keepUntouched(now) {
    const waiting = this._unsent;
    this._unsent = [];
    for (const u of waiting) {
      if (this._untouched(u, now)) this._unsent.push(u);
      else u.stale = true;
    }
  }

  // Whether `unsent`'s own `recheck` holds on `raw` (the document it would
  // now go on, before it). True for an edit without one.
  _recheck(unsent, raw) {
    if (!unsent.recheck) return true;
    try {
      return !!unsent.recheck(this._snapshot(raw, this._asOf));
    } catch (err) {
      console.error('An edit could not be checked again on the latest version:', err);
      return false;
    }
  }

  // What `unsent` writes, worked out once from the document it was made on
  // and the one it made: its footprint (rebase.js) and the pending ids it
  // makes and names. Null when it was not kept (no patch, or past
  // KEEP_BASES).
  _summary(unsent) {
    if (unsent.ids === undefined) {
      if (!unsent.base || !unsent.made) return null;
      unsent.footprint = footprintOf(unsent.base, unsent.made);
      unsent.ids = pendingIdsOf(unsent.base, unsent.made);
    }
    return { footprint: unsent.footprint, made: unsent.made, ...unsent.ids };
  }

  // The pending ids `unsent` makes, read once, before anything else reads
  // its base: every send asks, so it is not `_summary`'s whole diff. Null
  // when it was not kept.
  _created(unsent) {
    if (unsent.created === undefined) {
      unsent.created = unsent.base && unsent.made ? createdIdsOf(unsent.base, unsent.made) : null;
    }
    return unsent.created;
  }

  // Whether `unsent` names a row an edit refused before it made.
  _namesRefused(unsent) {
    if (this._refusedIds.size === 0) return false;
    // The whole diff only when the edit names a refused id at all: one
    // refused create would otherwise cost every later send of the page a
    // read of the whole document twice (REV-FX-UI F1).
    if (!unsent.made || !namesAnyOf(unsent.made, this._refusedIds)) return false;
    const summary = this._summary(unsent);
    if (!summary) return false;
    for (const id of summary.named) {
      if (!summary.created.has(id) && this._refusedIds.has(id)) return true;
    }
    return false;
  }

  // Whether nothing that changed between the document `unsent` was last
  // checked against and `now` touches what it writes, by layer or, when it
  // was opted in, by entity (rebase.js `resendable`). From then on it is
  // checked against `now`.
  _untouched(unsent, now) {
    if (!unsent.base || unsent.beside) return false;
    const { footprint } = this._summary(unsent);
    // Both read against the base the edit was made on, which this replaces.
    this._created(unsent);
    if (!this._resendable(unsent, footprint, now)) return false;
    unsent.origin ??= unsent.base;
    unsent.base = now;
    return true;
  }

  // Whether nothing that changed between `unsent.base` and `now` touches
  // `footprint`, what `unsent` writes: by layer, or by entity when it was
  // opted in (rebase.js `resendable`). A subclass that knows what its rows
  // mean may judge its own rows by a rule of its own and leave the rest to
  // this one (plaid-umr: a UMR edit and a change to another sentence's
  // graph). `unsent.origin ?? unsent.base` and `unsent.made` are the
  // document the edit was made on and the one it made.
  _resendable(unsent, footprint, now) {
    return resendable(footprint, unsent.base, now, { byEntity: unsent.byEntity });
  }

  // The version the server checks this document's writes against, or null
  // when its writes go unchecked (not in strict mode, or no version known).
  _checkedVersion() {
    const client = this._client;
    if (!client || client.strictModeDocumentId !== this.id) return null;
    return client.documentVersions?.[this.id] ?? null;
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
  // Whether a patch changed what the subclass keeps beside the document,
  // handed the context `_patchContext` made for it, before `_afterPatch`
  // takes it in. An edit that did is never sent again by itself after a
  // refusal: no read of the document shows what it changed, so nothing can
  // tell whether someone else changed the same.
  _changesBeside(context) {
    void context;
    return false;
  }

  // Apply an optimistic local-state patch. The producer receives a deep clone
  // of `_raw` plus the subclass's context for that clone, mutates in place, and
  // the result replaces `_raw`. Emits, so every `_raw` swap goes hand in hand
  // with a version bump and a notify, which is the invariant every derived
  // value relies on.
  _applyRawPatch(producer) {
    const base = this._raw;
    const seen = { beside: false };
    this._raw = this._patched(this._raw, producer, seen);
    this._dataVersion++;
    this._emit();
    if (this._patches.length === 0) {
      this._patchBase = base;
      queueMicrotask(() => {
        this._patches = [];
        this._patchBase = null;
        this._patchesBeside = false;
      });
    }
    this._patches.push(producer);
    if (seen.beside) this._patchesBeside = true;
  }

  // `raw` with `producer` applied to a clone of it. `seen.beside` says
  // whether it changed what the subclass keeps beside the document.
  _patched(raw, producer, seen = null) {
    const next = cloneRaw(raw);
    const context = this._patchContext(next);
    producer(next, ...context);
    if (seen) seen.beside = this._changesBeside(context);
    this._afterPatch(next, context);
    return next;
  }

  // Put `updated`, just read from the server, on screen with the edits still
  // waiting to be sent shown on top of it, each as it was shown when it was
  // made. A patch that no longer applies (it named something the refetch
  // does not hold) is left out: its send is refused in turn, or the refetch
  // once the queue has drained shows what landed.
  //
  // With `recheck`, each edit that carries a `recheck` is asked it first, on
  // what was read with the edits ahead of it shown, and one that fails it is
  // refused unsent, like a conflict, and not shown.
  _showUnsent(updated, { recheck = false } = {}) {
    let raw = updated;
    for (const u of this._unsent) {
      if (recheck && !this._recheck(u, raw)) {
        u.stale = true;
        continue;
      }
      for (const producer of u.patches) {
        try {
          raw = this._patched(raw, producer);
        } catch (err) {
          console.error('An edit waiting to be sent could not be shown again:', err);
        }
      }
    }
    if (recheck) this._unsent = this._unsent.filter((u) => !u.stale);
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
  // could make a second value where someone else has made one. Each one that
  // what changed touches (rebase.js) is refused as well, without being sent,
  // and taken off the screen with it. The others go in turn.
  async _reloadAfterFailure(conflict = false) {
    if (!this._client || !this.id) return;
    const updated = await this._fetch();
    await this._adoptReload(updated);
    if (conflict && this._client.strictModeDocumentId === this.id) {
      // Only those that what changed elsewhere touches (rebase.js). The rest
      // are shown again and sent in turn, each checked on its own.
      this._keepUntouched(updated);
      this._showUnsent(updated, { recheck: true });
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

  // Every read of the document goes through here, and settles the rows it
  // holds that an edit made and was refused for. A read that finds the
  // document deleted says so (`_documentGone`) and still throws, so the
  // caller's own failure path runs.
  async _fetch() {
    let raw;
    try {
      raw = await this._client.documents.get(this.id, true, this._asOf || undefined);
    } catch (err) {
      if (!this._asOf && isDocumentGone(err)) this._documentGone();
      throw err;
    }
    this._settleFound(raw);
    return raw;
  }

  // The document was deleted while it was open (H36-SETTINGS-LIVE-2). Said
  // once, and from then on the page is read-only for everyone: the project
  // kept is marked so (permissions.js `asDeletedDocument`), and every edit is
  // refused unsent. What the screen shows stays, so what was
  // typed can be copied.
  _documentGone() {
    if (this._deleted) return;
    this._deleted = true;
    if (!this._takeProject(this._project)) this._emit();
    if (this.onError) this.onError(DELETED, null, 'Read-only');
  }

  // A row an edit made under the id this page minted, and that the edit was
  // then refused for, is on the server after all when a read holds it (the
  // create landed with its answer lost). It is made, not refused: an edit
  // that names it is sent.
  _settleFound(raw) {
    const watched = [...this._refusedIds];
    if (watched.length === 0) return;
    const text = JSON.stringify(raw);
    const found = watched.filter((id) => text.includes(id));
    for (const id of found) this._refusedIds.delete(id);
    recordSettled(found.map((id) => [id, id]));
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
  // `interrupted` for a repair that failed partway. A repair whose writes all
  // landed and whose refetch (or check) after them failed carries
  // `refreshError` in their place: it is whole, so it keeps the label that
  // names it, and only the screen is behind. Every heal write folds
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
          let result = await this._reconcile();
          // Refused because the document moved on, as when another page
          // opening it at the same time repaired it first: read it again and
          // repair once more, so this page shows the document as repaired.
          if (statusOf(result.error) === 409) {
            const reread = await this._reload().then(
              () => true,
              () => false,
            );
            if (reread) result = await this._reconcile();
          }
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
