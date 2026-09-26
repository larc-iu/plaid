// The one write queue behind every optimistic write: DocumentModel's, and the
// vocabulary screens' in plaid-igt. The caller shows the edit first, then
// hands its send here. Sends run one at a time, in the order the edits were
// made, so an edit made while another is in flight is on screen at once and
// its send waits its turn.
//
// A refused send runs the caller's `refused`, which reports it and refetches,
// and that refetch takes the edits queued behind it off the screen as well. So
// once `refused` has finished (or failed) the generation moves on, and every
// send queued before then is skipped: the ones behind the refusal, and one
// made while its refetch was on the wire.
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
// No imports: plaid-ud's node suite reaches DocumentModel, and through it this
// file, by relative path.

export class WriteQueue {
  /**
   * `onSavingChange(saving)` runs when the queue starts and when it drains.
   * `reloadDrained()` runs once the last queued send has landed, when a send
   * asked for the server's view with `reloadWhenDrained`. It runs before the
   * queue reports itself drained, so `isSaving` holds through it.
   */
  constructor({ onSavingChange = null, reloadDrained = null } = {}) {
    this._tail = Promise.resolve();
    // Sends waiting or in flight.
    this._count = 0;
    // Every send ever queued, so a reader can tell that one was made while it
    // was on the wire, even one that has since landed.
    this._pushes = 0;
    this._generation = 0;
    this.reloadWhenDrained = false;
    this._onSavingChange = onSavingChange;
    this._reloadDrained = reloadDrained;
    this._listeners = new Set();
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
   * skipped. `refused(err)` reports a refusal and, for a write that showed
   * something, refetches what it showed.
   */
  push(send, { refused = null, shown = true } = {}) {
    const generation = this._generation;
    this._count += 1;
    this._pushes += 1;
    if (this._count === 1) this._savingChanged(true);
    const run = async () => {
      try {
        if (shown && generation !== this._generation) return false;
        await send();
        return true;
      } catch (err) {
        if (shown) this.reloadWhenDrained = false;
        try {
          if (refused) await refused(err);
        } catch (refetchErr) {
          console.error('Reload after a refused write also failed:', refetchErr);
        }
        if (shown) this._generation += 1;
        return false;
      } finally {
        if (this._count === 1 && this.reloadWhenDrained && this._reloadDrained) {
          try {
            await this._reloadDrained();
          } catch (err) {
            console.error('Reload after a write failed:', err);
          }
        }
        this._count -= 1;
        if (this._count === 0) this._savingChanged(false);
      }
    };
    const result = this._tail.then(run);
    this._tail = result.catch(() => {});
    return result;
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
