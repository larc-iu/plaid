import { useEffect, useRef, useState } from 'react';

// A Preview puts focus on what it found: the bar over the results, which
// holds the count and Apply. The panel calls `shown()` once the plan is set,
// and hands `ref` to its ApplyBar.
export const usePreviewFocus = () => {
  const ref = useRef(null);
  const [previews, setPreviews] = useState(0);
  useEffect(() => {
    if (previews) ref.current?.focus({ preventScroll: true });
  }, [previews]);
  return { ref, shown: () => setPreviews((n) => n + 1) };
};
