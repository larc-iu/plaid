// The one write queue behind every optimistic write: DocumentModel's, and the
// vocabulary screens' in plaid-igt. The caller shows the edit first, then
// hands its send here. Sends run one at a time, in the order the edits were
// made, so an edit made while another is in flight is on screen at once and
// its send waits its turn.
//
// A refused send runs the caller's `refused`, which reports it, and then its
// `resync`, the refetch that takes the refused edit back off the screen. That
// refetch takes the edits queued behind it off the screen as well, so once it
// has landed the generation moves on, and every send queued before then is
// not sent: the ones behind the refusal, and one made while its refetch was on
// the wire. `notSent(n)` hears how many. `_behindRefusal` is the one place
// that decides it.
//
// A `resync` that fails is tried again until it lands, with the queue held
// (`isSaving` stays true) all the while: until then the screen shows an edit
// the server does not have, and closing the tab must still ask. A caller that
// passes no `resync` refetches inside `refused` and gets one try.
//
// Only the network is waited out that way. A refetch that fails for any other
// reason (the server's error, a bug in the refetch itself) is given a few
// tries and then given up, and `onOutOfStep(err)` says the screen no longer
// matches the server. Retrying that forever would keep "Saving" and the
// close-tab question on for good.
//
// Once the screen showing the queue's work has gone (`letGo`), nothing is
// left for a refetch to put right. The queue still sends what it holds, but
// refetches nothing, and a retry waiting its turn stops at once. `hold` says
// whether a refetch was left undone meanwhile, for a screen that comes back.
//
// `shown: false` is for a write that put nothing on screen (a copy). Nothing
// was planned on it, so a refusal ahead of it does not skip it, and its own
// failure takes nothing back and skips nothing behind it.
//
// A refetch from OUTSIDE the queue (a service run, an import, the assistant)
// waits until the queue has drained, and reads again when a write is queued
// while it is on the wire (`readWhenIdle`), so the screen never shows a read
// that misses an edit the server is still to get. A refetch from INSIDE a send
// cannot wait for the queue, which is waiting on it.
//
// `isSaving` and `subscribe` are the shape `useSavingGuard` watches, so
// closing the tab asks while anything is still on its way.
//
// One import, lib/errors.js, which imports nothing: plaid-ud's node suite
// reaches DocumentModel, and through it this file, by relative path.

import { isUnreachable, statusOf } from '../lib/errors.js';

// Refetch failures that no retry can mend: signed out, no access, or gone.
const FINAL_STATUSES = new Set([401, 403, 404]);

// How long to wait before retrying a refetch: 1 s, 2 s, 4 s, then every 15 s.
const backoff = (attempt) => Math.min(1000 * 2 ** attempt, 15000);

// How many tries a refetch gets when it fails for a reason other than the
// network.
const TRIES = 4;

export class WriteQueue {
  /**
   * `onSavingChange(saving)` runs when the queue starts and when it drains.
   * `reloadDrained()` runs once the last queued send has landed, when a send
   * asked for the server's view with `reloadWhenDrained`. It runs before the
   * queue reports itself drained, so `isSaving` holds through it, and like a
   * `resync` it is tried again until it lands. `retryDelay(attempt)` is the
   * wait in milliseconds before each retry. `onOutOfStep(err)` runs when a
   * refetch is given up for good, the screen still showing what the server
   * may not have.
   */
  constructor({
    onSavingChange = null,
    reloadDrained = null,
    retryDelay = backoff,
    onOutOfStep = null,
  } = {}) {
    this._tail = Promise.resolve();
    // Sends waiting or in flight.
    this._count = 0;
    // Every send ever queued, so a reader can tell that one was made while it
    // was on the wire, even one that has since landed.
    this._pushes = 0;
    this._generation = 0;
    // Sends queued and not started yet, each as `{ generation, shown }`.
    this._waiting = new Set();
    this.reloadWhenDrained = false;
    this._onSavingChange = onSavingChange;
    this._reloadDrained = reloadDrained;
    this._retryDelay = retryDelay;
    this._onOutOfStep = onOutOfStep;
    this._listeners = new Set();
    // Whether the screen showing this queue's work has gone (`letGo`), and
    // whether a refetch was left undone since.
    this._letGo = false;
    this._missed = false;
    // Ends the wait before a retry early.
    this._wake = null;
  }

  /**
   * The screen showing this queue's work has gone. What is queued is still
   * sent, but nothing is refetched, and a refetch being retried stops.
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
   * Queue `send`. Resolves true when it landed, false when it was refused or
   * not sent. `refused(err)` reports a refusal. For a write that showed
   * something, `resync()` refetches what it showed, and `notSent(n)` is told
   * how many sends queued behind it were not sent, when there were any.
   */
  push(send, { refused = null, resync = null, notSent = null, shown = true } = {}) {
    const entry = { generation: this._generation, shown };
    this._waiting.add(entry);
    this._count += 1;
    this._pushes += 1;
    if (this._count === 1) this._savingChanged(true);
    const run = async () => {
      this._waiting.delete(entry);
      try {
        if (shown && entry.generation !== this._generation) return false;
        await send();
        return true;
      } catch (err) {
        if (shown) this.reloadWhenDrained = false;
        try {
          if (refused) await refused(err);
        } catch (refetchErr) {
          console.error('Reload after a refused write also failed:', refetchErr);
        }
        if (!shown) return false;
        if (resync) await this._refetch(resync, 'Reload after a refused write');
        const behind = this._behindRefusal();
        if (behind > 0 && notSent) notSent(behind);
        return false;
      } finally {
        if (this._count === 1 && this.reloadWhenDrained && this._reloadDrained) {
          await this._refetch(this._reloadDrained, 'Reload after a write');
        }
        this._count -= 1;
        if (this._count === 0) this._savingChanged(false);
      }
    };
    const result = this._tail.then(run);
    this._tail = result.catch(() => {});
    return result;
  }

  // What becomes of the sends queued behind a refusal once its refetch has
  // landed, and how many of them it touches. They were shown on top of the
  // refused edit and the refetch has taken them off the screen with it, so
  // today they are not sent: the generation moves on, and each resolves false
  // in its turn, which is how a screen knows to put its value back.
  //
  // To send them instead: return 0 here without moving the generation, and
  // set `this.reloadWhenDrained = true` so the screen is refetched once they
  // have landed and shows them again. Nothing else in the queue changes.
  _behindRefusal() {
    let behind = 0;
    for (const w of this._waiting) {
      if (w.shown && w.generation === this._generation) behind += 1;
    }
    this._generation += 1;
    return behind;
  }

  // Run the refetch `fn` until it lands, waiting longer after each failure.
  // Stops on an answer no retry can change, after a few tries for a failure
  // that is not the network's (and says so), and as soon as the queue is let
  // go.
  async _refetch(fn, what) {
    for (let attempt = 0; ; attempt += 1) {
      if (this._letGo) {
        this._missed = true;
        this.reloadWhenDrained = false;
        return;
      }
      try {
        await fn();
        return;
      } catch (err) {
        console.error(`${what} failed:`, err);
        if (FINAL_STATUSES.has(statusOf(err))) return;
        // The network's failures (`isUnreachable`, the same test that words
        // them "Could not reach the server") are waited out.
        if (!isUnreachable(err) && attempt + 1 >= TRIES) {
          if (this._onOutOfStep) this._onOutOfStep(err);
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
