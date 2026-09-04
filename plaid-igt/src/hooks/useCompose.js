import * as React from 'react';
import { attachCompose } from '@/lib/composeInput.js';

/**
 * Wire the backslash composer to an input or textarea, and merge the result
 * with whatever ref the caller passed. Returns the ref to spread.
 *
 * A native listener rather than React's `onBeforeInput`, whose synthetic event
 * has never carried `inputType` reliably across browsers.
 *
 * Opt in per field, never globally: a field holding a regex, a password, a URL
 * or a timecode must take a backslash literally. See components/ui/input.jsx.
 */
export function useCompose(enabled, forwardedRef) {
  const ref = React.useRef(null);

  const setRef = React.useCallback(
    (node) => {
      ref.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );

  React.useEffect(() => {
    if (!enabled) return undefined;
    return attachCompose(ref.current);
  }, [enabled]);

  return setRef;
}
