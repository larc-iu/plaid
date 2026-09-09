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
// `acquire` returns a release function, or null when the lock is already held —
// which is also what stops a second run from starting on top of the first.
// (Each spot has its own useServiceRequest, so its `isProcessing` only guards
// against itself.)
export function useWriteLock() {
  const [held, setHeld] = useState(null); // { label } while a run writes
  // The state is one render behind a synchronous second acquire, so the ref is
  // what actually arbitrates.
  const heldRef = useRef(false);

  const acquire = useCallback((label) => {
    if (heldRef.current) return null;
    heldRef.current = true;
    setHeld({ label });
    let released = false;
    return () => {
      if (released) return; // a release called twice must not free a later run
      released = true;
      heldRef.current = false;
      setHeld(null);
    };
  }, []);

  return { held, acquire };
}
