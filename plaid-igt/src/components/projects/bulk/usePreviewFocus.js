import { useEffect, useRef, useState } from 'react';

// A Preview puts focus on what it found: the bar over the results, which
// holds the count and Apply. The panel calls `begin()` as the preview starts
// and `shown()` once the plan is set, and hands `ref` to its ApplyBar.
//
// Only when nothing has moved on meanwhile: a preview takes seconds on a big
// project, and the fields stay open. If focus left the place the preview was
// started from, or the inputs (`inputs`, any value the panel's search is made
// of) changed, the person is doing something else and focus stays put.
export const usePreviewFocus = (inputs) => {
  const ref = useRef(null);
  const latest = useRef(inputs);
  latest.current = inputs;
  const started = useRef(null);
  const [previews, setPreviews] = useState(0);
  useEffect(() => {
    if (previews) ref.current?.focus({ preventScroll: true });
  }, [previews]);
  return {
    ref,
    begin: () => {
      started.current = { at: document.activeElement, inputs: latest.current };
    },
    shown: () => {
      const start = started.current;
      started.current = null;
      if (!start || start.inputs !== latest.current) return;
      const at = document.activeElement;
      if (at !== start.at && at !== document.body && at) return;
      setPreviews((n) => n + 1);
    },
  };
};
