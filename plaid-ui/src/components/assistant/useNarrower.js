import { useEffect, useState } from 'react';

// Whether the element `ref` holds is narrower than `px`, followed as it
// resizes. False until it is measured, and where there is no ResizeObserver.
export function useNarrower(ref, px) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const read = () => setNarrow(el.getBoundingClientRect().width < px);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, px]);
  return narrow;
}
