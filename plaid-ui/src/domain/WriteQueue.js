// The one write queue behind every optimistic write: DocumentModel's, and the
// vocabulary screens' in plaid-igt. The caller shows the edit first, then
// hands its send here. Sends run one at a time, in the order the edits were
// made, so an edit made while another is in flight is on screen at once and
// its send waits its turn.
//
// A refused send runs the caller's `refused`, which reports it, and then its
// `resync`, the refetch that takes the refused edit back off the screen. The
// edits queued behind it are still sent, each in its turn, and once the last
// has landed the screen is refetched again (`_behindRefusal`). One that fails
// the same way is refused and reported in its own turn. DocumentModel's
// refetch shows them on top of what it read. A caller whose refetch cannot
// (the vocabulary screens) has them off the screen until that last refetch.
//
// A `resync` that fails is tried again until it lands, with the queue held
// (`isSaving` stays true) all the while: until then the screen shows an edit
// the server does not have, and closing the tab must still ask. While it is
// the network that fails, `isOffline` is true. A caller that passes no
// `resync` refetches inside `refused` and gets one try.
//
// Only the network is waited out that way. A refetch that fails for any other
// reason (the server's error, a bug in the refetch itself) is given a few
// tries and then given up, and `onOutOfStep(err)` says the screen no longer
// matches the server. Retrying that forever would keep "Saving" and the
// close-tab question on for good.
//
// Once the screen showing the queue's work has gone (`letGo`), nothing is
// left for a refetch to put right. The queue refetches nothing, and a refetch
// being retried stops at once. What it holds is still sent, and a send
// waiting for the network keeps waiting, for as long as the page is open.
// `hold` says whether a refetch was left undone meanwhile, for a screen that
// comes back.
//
// `shown: false` is for a write that put nothing on screen (a copy). Its
// failure takes nothing back, so it refetches nothing.
//
// A refetch from OUTSIDE the queue (a service run, an import, the assistant)
// waits until the queue has drained, and reads again when a write is queued
// while it is on the wire (`readWhenIdle`), so the screen never shows a read
// that misses an edit the server is still to get. A refetch from INSIDE a send
// cannot wait for the queue, which is waiting on it.
//
// `isSaving`, `isOffline` and `subscribe` are the shape `useSavingGuard` and
// the save-status pills watch, so closing the tab asks while anything is
// still on its way.
//
// A send whose answer never came (no response, a 502 or 504 from a proxy)
// goes again, when the caller's `resendWhenBack(err)` says so, instead of
// being refused, and again, waiting a little longer each time and at once
// when the browser says the network is back, until the server answers.
// Meanwhile `isOffline` is true, so "Saving" and the close-tab question stay
// on. A caller asks for it when its sends are keyed (an Idempotency-Key per
// request, the same on every attempt): the requests of an attempt that
// landed are answered from what they stored and write nothing twice. The
// wait has no end while the page is open: a proxy's 502 or 504 is the
// server's fault as much as a connection refused, and the edits behind the
// send wait their turn and land in order once it is answered. That holds
// after the queue is let go too: the page is still open, and useSavingGuard
// keeps the close-tab question on until the send lands.
//
// Once the page is being unloaded (`pagehide`), no send starts. Leaving the
// page aborts the send in flight, and the one behind it would otherwise go
// out after the person agreed to leave. A page brought back from the
// back-forward cache (`pageshow`) sends on.
//
// One import, lib/errors.js, which imports nothing: plaid-ud's node suite
// reaches DocumentModel, and through it this file, by relative path.

import { isUnreachable, statusOf } from '../lib/errors.js';

// Refetch failures that no retry can mend: signed out, no access, or gone.
const FINAL_STATUSES = new Set([401, 403, 404]);

// How long to wait before a send or a refetch goes again: 1 s, 2 s, 4 s and
// so on, then every 30 s.
const backoff = (attempt) => Math.min(1000 * 2 ** attempt, 30000);

// How many tries a refetch gets when it fails for a reason other than the
// network.
const TRIES = 4;

// Whether the page is being unloaded, and the sends waiting for it to be
// shown again. Page-wide, since unloading is.
let unloading = false;
const whenShown = new Set();
globalThis.addEventListener?.('pagehide', () => {
  unloading = true;
});
globalThis.addEventListener?.('pageshow', () => {
  unloading = false;
  const waiting = [...whenShown];
  whenShown.clear();
  waiting.forEach((go) => go());
});
const untilShown = () =>
  unloading ? new Promise((resolve) => whenShown.add(resolve)) : Promise.resolve();

export class WriteQueue {
  /**
   * `onSavingChange(saving)` runs when the queue starts and when it drains.
   * `reloadDrained()` runs once the last queued send has landed, when a send
   * asked for the server's view with `reloadWhenDrained`. It runs before the
   * queue reports itself drained, so `isSaving` holds through it, and like a
   * `resync` it is tried again until it lands. `retryDelay(attempt)` is the
   * wait in milliseconds before each retry. `onOutOfStep(err)` runs when a
   * refetch is given up for good, the screen still showing what the server
   * may not have. `onOfflineChange(offline)` runs when a refetch starts or
   * stops waiting out the network.
   */
  constructor({
    onSavingChange = null,
    reloadDrained = null,
    retryDelay = backoff,
    onOutOfStep = null,
    onOfflineChange = null,
  } = {}) {
    this._tail = Promise.resolve();
    // Sends waiting or in flight.
    this._count = 0;
    // Every send ever queued, so a reader can tell that one was made while it
    // was on the wire, even one that has since landed.
    this._pushes = 0;
    // Sends queued and not started yet, each as `{ shown }`.
    this._waiting = new Set();
    this.reloadWhenDrained = false;
    // A caller's `resync`, run again once the sends behind its refusal have
    // landed, for a queue with no `reloadDrained` of its own.
    this._resyncWhenDrained = null;
    this._onSavingChange = onSavingChange;
    this._reloadDrained = reloadDrained;
    this._retryDelay = retryDelay;
    this._onOutOfStep = onOutOfStep;
    this._onOfflineChange = onOfflineChange;
    this._offline = false;
    // Whether `onOutOfStep` has been told since a refetch last landed.
    this._outOfStep = false;
    // Whether a refetch was answered with a status no retry can change
    // (FINAL_STATUSES) since one last landed.
    this._refetchRefused = false;
    this._listeners = new Set();
    // Whether the screen showing this queue's work has gone (`letGo`), and
    // whether a refetch was left undone since.
    this._letGo = false;
    this._missed = false;
    // End the wait before a refetch's retry early.
    this._wake = null;
  }

  /**
   * The screen showing this queue's work has gone. Nothing is refetched, and
   * a refetch being retried stops. What is queued is still sent, and a send
   * waiting for the network keeps waiting.
   */
  letGo() {
    this._letGo = true;
    if (this._wake) this._wake();
  }

  /**
   * A screen shows this queue's work again. True when a refetch was left
   * undone while it was let go, so the caller refetches.
   */
  hold() {
    this._letGo = false;
    const missed = this._missed;
    this._missed = false;
    return missed;
  }

  get isSaving() {
    return this._count > 0;
  }

  /**
   * True while a refetch is waiting for the server to be reachable again.
   * Editing goes on meanwhile: every edit is still queued and sent.
   */
  get isOffline() {
    return this._offline;
  }

  /**
   * True once a refetch was given up for a reason other than the network
   * (`onOutOfStep`), or answered 401, 403 or 404, until a later refetch
   * lands: the screen may still show an edit the server does not have. False
   * while a refetch is still being tried, and after one that landed.
   */
  get outOfStep() {
    return this._outOfStep || this._refetchRefused;
  }

  _setOffline(offline) {
    if (this._offline === offline) return;
    this._offline = offline;
    if (this._onOfflineChange) this._onOfflineChange(offline);
    this._listeners.forEach((fn) => fn());
  }

  /** Sends waiting or in flight, the one running included. */
  get queued() {
    return this._count;
  }

  /** How many sends have ever been queued. */
  get pushes() {
    return this._pushes;
  }

  subscribe = (fn) => {
    this._listeners.add(fn);
    return () => {
      this._listeners.delete(fn);
    };
  };

  _savingChanged(saving) {
    if (this._onSavingChange) this._onSavingChange(saving);
    this._listeners.forEach((fn) => fn());
  }

  /**
   * Queue `send`. Resolves true when it landed, false when it was refused.
   * `refused(err)` reports a refusal. For a write that showed something,
   * `resync()` refetches what it showed. `resendWhenBack(err)` says whether a
   * failed send goes again until it is answered: true for a lost answer to a
   * send whose requests are keyed, so a resend writes nothing twice.
   */
  push(send, { refused = null, resync = null, shown = true, resendWhenBack = null } = {}) {
    const entry = { shown };
    this._waiting.add(entry);
    this._count += 1;
    this._pushes += 1;
    if (this._count === 1) this._savingChanged(true);
    const run = async () => {
      this._waiting.delete(entry);
      await untilShown();
      try {
        await this._sendUntilBack(send, resendWhenBack);
        return true;
      } catch (err) {
        // Its own refetch below stands in for one asked for earlier.
        if (shown) this.reloadWhenDrained = false;
        if (shown && resync) this._resyncWhenDrained = null;
        try {
          if (refused) await refused(err);
        } catch (refetchErr) {
          console.error('Reload after a refused write also failed:', refetchErr);
        }
        if (!shown) return false;
        if (resync) await this._refetch(resync, 'Reload after a refused write');
        this._behindRefusal(resync);
        return false;
      } finally {
        if (this._count === 1) await this._refetchDrained();
        this._count -= 1;
        if (this._count === 0) this._savingChanged(false);
      }
    };
    const result = this._tail.then(run);
    this._tail = result.catch(() => {});
    return result;
  }

  // Run `send`, and again each time it fails in a way `resendWhenBack` allows,
  // once the network is back. `isOffline` holds while it waits.
  async _sendUntilBack(send, resendWhenBack) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await send();
        if (attempt) this._setOffline(false);
        return;
      } catch (err) {
        if (!resendWhenBack?.(err)) {
          if (attempt) this._setOffline(false);
          throw err;
        }
        console.error('A write got no answer, and goes again until it does:', err);
        this._setOffline(true);
        await this._untilOnline(this._retryDelay(attempt));
        await untilShown();
      }
    }
  }

  // Resolves after `ms`, or as soon as the browser says the network is back.
  _untilOnline(ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        globalThis.removeEventListener?.('online', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      globalThis.addEventListener?.('online', done);
    });
  }

  // What becomes of the sends queued behind a refusal once its refetch has
  // landed. They were shown on top of the refused edit, and the refetch has
  // taken them off the screen with it, but they are still sent: once the last
  // of them has landed, the screen is refetched again and shows them. With no
  // `reloadDrained` of the queue's own, that refetch is the caller's `resync`.
  _behindRefusal(resync) {
    const behind = [...this._waiting].some((w) => w.shown);
    if (!behind) return;
    if (this._reloadDrained) this.reloadWhenDrained = true;
    else if (resync) this._resyncWhenDrained = resync;
  }

  // The last queued send has landed (or been refused): refetch, when a send
  // asked for the server's view or sends behind a refusal wait to be shown.
  async _refetchDrained() {
    if (this.reloadWhenDrained && this._reloadDrained) {
      this._resyncWhenDrained = null;
      await this._refetch(this._reloadDrained, 'Reload after a write');
    } else if (this._resyncWhenDrained) {
      const resync = this._resyncWhenDrained;
      this._resyncWhenDrained = null;
      await this._refetch(resync, 'Reload after the writes behind a refusal');
    }
  }

  // Run the refetch `fn` until it lands, waiting longer after each failure.
  // Stops on an answer no retry can change, after a few tries for a failure
  // that is not the network's (and says so), and as soon as the queue is let
  // go.
  //
  // Only the server's own failures count against the tries: a server coming
  // back after a long outage may fail once while it starts, and that is its
  // first failure, not its tenth.
  async _refetch(fn, what) {
    let failed = 0;
    for (let attempt = 0; ; attempt += 1) {
      if (this._letGo) {
        this._missed = true;
        this.reloadWhenDrained = false;
        this._setOffline(false);
        return;
      }
      try {
        await fn();
        this._setOffline(false);
        this._outOfStep = false;
        this._refetchRefused = false;
        return;
      } catch (err) {
        console.error(`${what} failed:`, err);
        // The network's failures (`isUnreachable`, the same test that words
        // them "Could not reach the server") are waited out.
        const unreachable = isUnreachable(err);
        this._setOffline(unreachable);
        if (FINAL_STATUSES.has(statusOf(err))) {
          this._refetchRefused = true;
          return;
        }
        if (!unreachable && ++failed >= TRIES) {
          // Said once: a refetch after it that fails the same way adds nothing.
          if (this._onOutOfStep && !this._outOfStep) this._onOutOfStep(err);
          this._outOfStep = true;
          return;
        }
        await this._sleep(this._retryDelay(attempt));
      }
    }
  }

  // Wait `ms`, or less when the queue is let go meanwhile.
  _sleep(ms) {
    if (this._letGo) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this._wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this._wake = done;
    });
  }

  /** Resolves once nothing is queued. Never call it from inside a send. */
  async whenIdle() {
    while (this._count > 0) await this._tail;
  }

  /**
   * `read()` from outside the queue: once every queued send has landed, and
   * again whenever a send was queued while it was on the wire.
   */
  async readWhenIdle(read) {
    for (;;) {
      await this.whenIdle();
      const seen = this._pushes;
      const value = await read();
      if (this._pushes === seen) return value;
    }
  }
}
