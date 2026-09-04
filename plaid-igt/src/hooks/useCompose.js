import * as React from 'react';
import { attachCompose, setComposeProject } from '@/lib/composeInput.js';

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

/**
 * Point the composer at the open project's own codes, for as long as this
 * screen is up. Called from the two places that hold a project (the project
 * page and the document page), so a code bound in Settings works everywhere in
 * the app without every field having to know about the project.
 */
export function useComposeProject(project) {
  React.useEffect(() => {
    setComposeProject(project ?? null);
    return () => setComposeProject(null);
  }, [project]);
}
