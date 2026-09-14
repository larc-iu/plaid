import { vi } from 'vitest';

// requestAnimationFrame with a hand crank.
//
// A hook that drives something frame by frame (the timeline needle, the range
// monitor) only ever LOOKS right: the loop reschedules itself, so a test that
// lets frames happen on their own cannot say which frame drew what, and cannot
// say whether the last one was cancelled. Pumping by hand makes each frame a
// step in the test, and `pending` is the answer to "is anything still
// scheduled?" after an unmount.
export function fakeRaf() {
  let nextId = 1;
  const pending = new Map();

  const request = vi.fn((cb) => {
    const id = nextId++;
    pending.set(id, cb);
    return id;
  });
  const cancel = vi.fn((id) => {
    pending.delete(id);
  });

  return {
    request,
    cancel,
    /** How many frames are scheduled and not yet run. */
    get pending() {
      return pending.size;
    },
    /** Take over the globals. Undo with `vi.unstubAllGlobals()`. */
    install() {
      vi.stubGlobal('requestAnimationFrame', request);
      vi.stubGlobal('cancelAnimationFrame', cancel);
      return this;
    },
    /**
     * Run everything scheduled as of now, once. A callback scheduled by one of
     * them waits for the next pump, the way a real frame does.
     * @returns {number} how many ran
     */
    pump(time = 0) {
      const due = [...pending.values()];
      pending.clear();
      for (const cb of due) cb(time);
      return due.length;
    },
  };
}
