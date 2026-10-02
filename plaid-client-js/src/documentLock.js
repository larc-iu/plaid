import { isUnknownOutcome, retryUnknown } from "./http.js";

/**
 * Keeping a document lock alive for as long as a `locked()` block runs.
 *
 * plaid-core expires a document lock about a minute after it was taken, and the
 * holder's own writes are what renew it (`plaid.sql.operation` calls
 * `refresh-locks!` on every write it accepts). That is the right rule for an
 * editor, which writes as the person types. It is the wrong one for a service:
 * a parser loads a model, reads the document, spends minutes in inference and
 * only then writes, so for most of its run it holds nothing. The lock lapses in
 * silence, a person's edit lands between the read the work was planned from and
 * the write about to go out, and the write clobbers it.
 *
 * A `locked()` block therefore renews on a timer of its own. The renewal is an
 * acquire that names the holder's `lockId`: the server refreshes the lock that
 * id holds, and refuses one somebody else holds (the same user included).
 *
 * The beat is unconditional rather than "only when no write has gone out
 * recently". The request layer knows the method of a call but not which
 * document it touched, so a write to some other document would count as a
 * renewal here and would not be one. Two extra requests a minute is the whole
 * cost.
 *
 * A renewal that fails means the block is no longer holding what it asked for,
 * so it stops the run: the loss is recorded on the client and every later write
 * throws `DocumentLockLost`. The guard sits in the request layer because the
 * callers are services, and a check they have to remember to call is a check
 * that is missing somewhere.
 */

/**
 * The lock a `documents.locked()` block was holding is no longer held.
 *
 * Thrown by the keep-alive when it cannot renew the lock, and then by the
 * request layer on every write this client attempts, so work that has been
 * running for minutes stops rather than writing over an edit that may have
 * landed while the lock was gone.
 */
export class DocumentLockLost extends Error {
  constructor(message, documentId, cause) {
    super(message);
    this.name = "DocumentLockLost";
    this.documentId = documentId;
    this.cause = cause;
  }
}

/**
 * How long a freshly taken lock lasts, from the server's own answer.
 *
 * `expiresAt` is the epoch-millisecond moment the lock endpoints return, on
 * the server's clock, so it is read against the server's clock too
 * (`client.serverNow()`): this machine's clock being off cannot stretch or
 * shrink the window. It is how a window an operator has retuned
 * (`:plaid.server.locks/config :expiration-ms`) reaches the keeper.
 *
 * An answer that cannot be a window (none, already over, past an hour) is
 * core's default, 60 s.
 *
 * @param {number} expiresAt
 * @param {number} serverNowMs
 * @returns {number}
 */
export function lockTtlMs(expiresAt, serverNowMs) {
  const ttl = expiresAt - serverNowMs;
  // No answer at all, or one past an hour or already over: this machine's
  // clock stood in for the server's (a page that cannot read its Date
  // header) and is far off. Core's default window is the better guess.
  return Number.isFinite(ttl) && ttl > 0 && ttl <= MAX_TTL_MS ? ttl : DEFAULT_TTL_MS;
}

// Core's default lock window, and the longest one believed.
const DEFAULT_TTL_MS = 60000;
const MAX_TTL_MS = 3600000;

/**
 * Renews one document's lock until the block holding it exits.
 *
 * `refresh` is called with the document id and must reject on failure.
 * `onLost` is called once, with the `DocumentLockLost`, when the lock can no
 * longer be assumed.
 *
 * `clock` and `sleep` exist so the whole policy can be run on a fake clock:
 * `sleep(delayMs)` resolves to true once the block has exited.
 */
export class LockKeeper {
  constructor(
    refresh,
    documentId,
    ttlMs,
    { onLost = null, clock = Date.now, sleep = null } = {},
  ) {
    this._refresh = refresh;
    this._documentId = documentId;
    this._ttlMs = ttlMs;
    this._onLost = onLost;
    this._clock = clock;
    this._sleep = sleep || ((ms) => this._defaultSleep(ms));
    this._stopped = false;
    this._wake = null;
    this._running = null;
    /** The `DocumentLockLost` this keeper raised, or null. */
    this.lost = null;
  }

  /**
   * Time between renewals: half the window, so a renewal that fails has a
   * second chance before the lock it is renewing expires.
   */
  get intervalMs() {
    return Math.max(1000, this._ttlMs / 2);
  }

  /**
   * Time before retrying a renewal that failed. A blip should not end a run
   * that the server still considers the holder of.
   */
  get retryMs() {
    return Math.max(500, this._ttlMs / 10);
  }

  _defaultSleep(ms) {
    if (this._stopped) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._wake = null;
        resolve(this._stopped);
      }, ms);
      // Never hold a Node process open on the beat alone.
      if (timer && typeof timer.unref === "function") timer.unref();
      this._wake = () => {
        clearTimeout(timer);
        this._wake = null;
        resolve(true);
      };
    });
  }

  /** The beat. Resolves when the block exits or the lock is lost. */
  async run() {
    let deadline = this._clock() + this._ttlMs;
    let delay = this.intervalMs;
    while (!(await this._sleep(delay))) {
      try {
        await this._refresh(this._documentId);
      } catch (error) {
        // 423 is definitive: somebody else holds the document now, or ours
        // expired or was dropped, and the server never takes it back.
        // Anything else may be a blip, and is only fatal once the lock we are
        // renewing has actually run out.
        if (error?.status === 423 || this._clock() >= deadline) {
          this._fail(error);
          return;
        }
        delay = this.retryMs;
        continue;
      }
      deadline = this._clock() + this._ttlMs;
      delay = this.intervalMs;
    }
  }

  start() {
    this._running = this.run();
    // Nothing awaits the beat: a failure inside it is reported through onLost,
    // not through this promise.
    this._running.catch(() => {});
    return this._running;
  }

  stop() {
    this._stopped = true;
    if (this._wake) this._wake();
  }

  _fail(error) {
    this.lost = new DocumentLockLost(
      `The lock on document ${this._documentId} lapsed: it could not be renewed.`,
      this._documentId,
      error,
    );
    if (this._onLost) this._onLost(this.lost);
  }
}

/**
 * What a `client.documents.locked(id, (lock) => ...)` block gets.
 *
 * The block does not have to consult it: a lost lock stops the next write on
 * its own. Read `lock.lost` (or call `lock.raiseIfLost()`) to give up earlier,
 * between steps of work that has not written anything yet.
 */
export class DocumentLock {
  constructor(documentId, keeper, lockId = null) {
    this.documentId = documentId;
    /** The holder id the acquire answered with. */
    this.lockId = lockId;
    this._keeper = keeper;
  }

  /** The `DocumentLockLost` if the lock lapsed, else null. */
  get lost() {
    return this._keeper ? this._keeper.lost : null;
  }

  raiseIfLost() {
    if (this.lost) throw this.lost;
  }
}

/**
 * The pause before sending again an acquire whose outcome is unknown, which
 * grows by this much each time (three sends in all).
 */
export const LOCK_ACQUIRE_RETRY_MS = 500;

function mintLockId() {
  return globalThis.crypto.randomUUID();
}

/**
 * The acquire of a `locked()` block, under the holder id it minted.
 *
 * An acquire whose outcome is unknown (no answer, a timeout, a 502 or a 504)
 * may have taken the lock. It is sent again under the same id as any write is
 * (`retryUnknown`), which the server answers 200 while that holder has it.
 * When every send is unknown (or the network went), the lock it may hold is
 * released on the way out, so it does not stand in everyone's way until it
 * expires.
 */
async function takeLock(client, documentId, lockId, retryMs) {
  try {
    return await retryUnknown(
      () => client.documents.acquireLock(documentId, undefined, lockId),
      { delaysMs: [retryMs, 2 * retryMs] },
    );
  } catch (error) {
    if (error?.status === 423) {
      // The error body is raw JSON off the wire, so it is still kebab-cased.
      const body = error.responseData || {};
      const holder = body.userId || body["user-id"] || "another user";
      const readable = new Error(
        `This document is being edited by ${holder}. Try again once they're done.`,
      );
      readable.status = 423;
      readable.statusText = error.statusText;
      readable.url = error.url;
      readable.method = error.method;
      readable.responseData = error.responseData;
      readable.cause = error;
      throw readable;
    }
    if (isUnknownOutcome(error)) {
      try {
        await client.documents.releaseLock(documentId, lockId);
      } catch {
        /* the lock expires on its own */
      }
    }
    throw error;
  }
}

/**
 * Hold `documentId`'s server-enforced lock for the length of `fn`.
 * `client.documents.locked` is the entry point; see its doc comment.
 *
 * @param {object} client
 * @param {string} documentId
 * @param {(lock: DocumentLock) => any} fn
 * @param {{ keepAlive?: boolean, acquireRetryMs?: number }} [options]
 */
export async function withDocumentLock(
  client,
  documentId,
  fn,
  { keepAlive = true, acquireRetryMs = LOCK_ACQUIRE_RETRY_MS } = {},
) {
  const minted = mintLockId();
  const info = await takeLock(client, documentId, minted, acquireRetryMs);

  const lockId = info?.lockId ?? minted;
  let keeper = null;
  if (keepAlive) {
    const ttlMs = lockTtlMs(info.expiresAt, client.serverNow().getTime());
    client.documentLockLost = null;
    keeper = new LockKeeper(
      (id) => client.documents.renewLock(id, lockId),
      documentId,
      ttlMs,
      {
        onLost: (lost) => {
          client.documentLockLost = lost;
        },
      },
    );
    keeper.start();
  }

  let result;
  let threw = false;
  try {
    result = await fn(new DocumentLock(documentId, keeper, lockId));
  } catch (error) {
    threw = true;
    throw error;
  } finally {
    if (keeper) keeper.stop();
    const lost = keeper ? keeper.lost : null;
    client.documentLockLost = null;
    // Best-effort release: the server TTL reclaims a stranded lock, and we must
    // not let a release failure mask the real error from the body.
    try {
      await client.documents.releaseLock(documentId, lockId);
    } catch {
      /* the lock expires on its own */
    }
    // A block that ran to the end without the lock it asked for did not do what
    // it says it did. Only throw when nothing else is already propagating, so
    // the real failure is never masked.
    if (lost && !threw) throw lost;
  }
  return result;
}
