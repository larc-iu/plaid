import { useEffect, useState } from 'react';

/**
 * True only once `active` has been continuously true for `delayMs`.
 *
 * For spinners over work that is usually instantaneous. Reconcile-on-open, for
 * instance, does all of its planning locally and touches the network only when
 * something actually needs healing — so gating its panel on the raw flag would
 * flash a spinner for one frame on every visit. Delaying the *appearance*
 * keeps the spinner for the passes that genuinely take time and makes the
 * no-op passes invisible.
 *
 * Falls back to false the instant `active` goes false, so nothing lingers.
 */
export const useDelayedFlag = (active, delayMs = 150) => {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!active) {
      setShown(false);
      return undefined;
    }
    const t = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(t);
  }, [active, delayMs]);

  return shown;
};
