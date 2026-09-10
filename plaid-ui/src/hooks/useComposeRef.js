import * as React from 'react';
import { composeAttacher } from '../lib/uiConfig.js';

/**
 * Merge a forwarded ref with this package's own, and hand the element to the
 * app's compose attacher while `enabled`. Returns the ref to spread.
 *
 * The hook is always called and always merges refs, whether or not an app has
 * registered an attacher, so the rules of hooks hold either way and a field's
 * `compose` prop is simply inert in an app with no composer. See
 * `lib/uiConfig.js`.
 *
 * A native listener rather than React's `onBeforeInput`, whose synthetic event
 * has never carried `inputType` reliably across browsers — which is why the
 * attacher takes the element rather than a handler.
 */
export function useComposeRef(enabled, forwardedRef) {
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
    const attach = composeAttacher();
    if (!attach) return undefined;
    return attach(ref.current);
  }, [enabled]);

  return setRef;
}
