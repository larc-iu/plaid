import { useCallback, useEffect, useRef } from 'react';

// Keeping a screen on the answer it asked for last.
//
// A loader keyed on a project, a document or an account is started again when
// that id changes, and one route component serves every id: the reader picks
// another project and the component stays mounted. Nothing orders the two
// requests, so the answer for the project just LEFT can land after the answer
// for the one just opened, and the screen then shows the wrong project's data
// with no sign that anything went wrong. The same shape ends a load on a
// screen that is gone, which React warns about and which hides a leak.
//
// `begin()` opens a call and hands back `isCurrent()`, false once a newer call
// has been opened or the component has unmounted. Ask it after EVERY await, on
// the failure path as well as the success one: a stale error empties a list
// that had just been filled, and a stale `finally` turns off a spinner the
// newest call is still using.
//
//   const begin = useLatestCall();
//   const load = useCallback(async () => {
//     const isCurrent = begin();
//     setLoading(true);
//     try {
//       const page = await client.projects.list(projectId);
//       if (!isCurrent()) return;
//       setRows(page.entries);
//     } finally {
//       if (isCurrent()) setLoading(false);
//     }
//   }, [begin, client, projectId]);
//
// For an effect that fetches inline, a plain `let cancelled = false` with a
// cleanup that sets it is the same guard written smaller, and is what those use.
export const useLatestCall = () => {
  const seq = useRef(0);
  // Unmounting invalidates whatever is out, so nothing sets state afterwards.
  useEffect(() => () => seq.current++, []);
  return useCallback(() => {
    const mine = ++seq.current;
    return () => seq.current === mine;
  }, []);
};
