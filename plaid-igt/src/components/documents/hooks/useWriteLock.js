import { useCallback, useRef, useState } from 'react';

// The document's write lock, held while a service run is writing to it.
//
// A run outlives its dialog by design, which is the whole point of being able
// to close the box. That leaves a window where a service is rewriting tokens,
// glosses or the baseline while the document sits there looking editable, and
// every run ends in a `_reload()` that would throw away whatever was typed in
// the meantime. So the document goes read-only for as long as a run writes.
//
// Only runs that WRITE take the lock. Speech detection does not: neither the
// in-browser model nor a `detect-speech` service writes anything, and a
// proposal becomes a segment by being typed into, so locking would break the
// gesture the feature exists for.
//
// The lock also carries the run's status, because it is the one thing on
// screen in the two cases where nothing else is: the user has switched to a
// tab that does not mount the run's own button, or the page was reloaded and
// the run was rejoined with no dialog open at all.
//
// The holder also supplies `onCancel`, so the run can be stopped from wherever
// the lock is visible. That matters most for a run this page did not start: a
// rejoined run lives in its own hook, so the tab's own dialog has no handle on
// it and could otherwise only sit there saying it was busy.
//
// `acquire` returns `{release, setStatus}`, or null when the lock is already
// held — which is also what stops a second run from starting on top of the
// first. (Each spot has its own useServiceRequest, so its `isProcessing` only
// guards against itself.)
export function useWriteLock() {
  const [held, setHeld] = useState(null); // { label, startedAt, status }
  // The state is one render behind a synchronous second acquire, so the ref is
  // what actually arbitrates.
  const heldRef = useRef(false);

  const acquire = useCallback((label, { onCancel = null } = {}) => {
    if (heldRef.current) return null;
    heldRef.current = true;
    setHeld({ label, startedAt: Date.now(), status: '', cancel: onCancel });
    let released = false;
    return {
      release: () => {
        if (released) return; // a release called twice must not free a later run
        released = true;
        heldRef.current = false;
        setHeld(null);
      },
      // What the run last said. Ignored once released, so a late progress
      // event cannot resurrect a finished run's status.
      setStatus: (status) => {
        if (released) return;
        setHeld((cur) => (cur && cur.status !== status ? { ...cur, status } : cur));
      },
    };
  }, []);

  return { held, acquire };
}
