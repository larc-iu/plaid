// How many of a screen's writes are still on their way, in the shape
// `useSavingGuard` watches (`isSaving`, `subscribe`), so closing the tab asks
// first until they have landed, even after the screen that made them is gone.
export function writeTracker() {
  const listeners = new Set();
  let pending = 0;
  const emit = () => listeners.forEach((fn) => fn());
  return {
    get isSaving() {
      return pending > 0;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    begin() {
      pending += 1;
      if (pending === 1) emit();
    },
    end() {
      pending -= 1;
      if (pending === 0) emit();
    },
  };
}
