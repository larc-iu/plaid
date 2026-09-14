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
 * A `locked()` block therefore renews on a timer of its own. The renewal is a
 * plain acquire: the server refreshes a lock whose holder asks for it again.
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
 * How long plaid-core holds a document lock before it expires, in ms.
 * `plaid.server.locks/default-lock-expiration-ms`. An operator can change it
 * with `:plaid.server.locks/config :expiration-ms`, and a server publishes what
 * it enforces as `lockExpirationMs` in `GET /info`. This is the last resort:
 * what a live lock is renewed against is the `expiresAt` on the acquire
 * response, which names the moment rather than the window.
 */
export const DOCUMENT_LOCK_TTL_MS = 60000;

// Widest lock lifetime we will believe from a server response. Past this the
// number is a clock skew between this machine and the server rather than a
// configured window, and the documented default is the better guess.
const MAX_BELIEVABLE_TTL_MS = 3600000;

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
 * `expiresAt` is the epoch-millisecond stamp the lock endpoints return.
 * Comparing it against this machine's clock is the only way to learn a window
 * an operator has retuned, and it is also the one place a clock skew can get
 * in, so an answer outside a believable band falls back to the documented
 * default rather than to a beat that never fires or fires constantly.
 *
 * @param {number|undefined} expiresAt
 * @param {number} nowMs
 * @param {number} [fallback]
 * @returns {number}
 */
export function lockTtlMs(
  expiresAt,
  nowMs,
  fallback = DOCUMENT_LOCK_TTL_MS,
) {
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    const ttl = expiresAt - nowMs;
    if (ttl > 0 && ttl <= MAX_BELIEVABLE_TTL_MS) return ttl;
  }
  return fallback;
}

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
    // A window under two seconds leaves no room for a retry; treat it as a
    // misconfiguration and beat at the documented rate instead.
    this._ttlMs = ttlMs >= 2000 ? ttlMs : DOCUMENT_LOCK_TTL_MS;
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
        // 423 is definitive: somebody else holds the document now, so ours had
        // already expired. Anything else may be a blip, and is only fatal once
        // the lock we are renewing has actually run out.
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
  constructor(documentId, keeper) {
    this.documentId = documentId;
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
 * Hold `documentId`'s server-enforced lock for the length of `fn`.
 * `client.documents.locked` is the entry point; see its doc comment.
 *
 * @param {object} client
 * @param {string} documentId
 * @param {(lock: DocumentLock) => any} fn
 * @param {{ keepAlive?: boolean }} [options]
 */
export async function withDocumentLock(
  client,
  documentId,
  fn,
  { keepAlive = true } = {},
) {
  let info;
  try {
    info = await client.documents.acquireLock(documentId);
  } catch (error) {
    if (error?.status === 423) {
      // The error body is raw JSON off the wire, so it is still kebab-cased.
      const body = error.responseData || {};
      const holder = body.userId || body["user-id"] || "another user";
      const readable = new Error(
        `Document ${documentId} is locked by ${holder} (likely being edited); try again once they're done.`,
      );
      readable.status = 423;
      readable.statusText = error.statusText;
      readable.url = error.url;
      readable.method = error.method;
      readable.responseData = error.responseData;
      readable.cause = error;
      throw readable;
    }
    throw error;
  }

  let keeper = null;
  if (keepAlive) {
    const ttlMs = lockTtlMs(info?.expiresAt, Date.now());
    client.documentLockLost = null;
    keeper = new LockKeeper(
      (id) => client.documents.acquireLock(id),
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
    result = await fn(new DocumentLock(documentId, keeper));
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
      await client.documents.releaseLock(documentId);
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
