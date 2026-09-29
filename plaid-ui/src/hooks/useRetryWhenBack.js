import { useEffect, useRef } from 'react';

// A read that failed is tried again when the reader is likely to be back: the
// browser says the network has returned, or the window gets the focus again.
// Only while `failed` is true, so a page that loaded listens to nothing.
export const useRetryWhenBack = (failed, retry) => {
  const latest = useRef(retry);
  useEffect(() => {
    latest.current = retry;
  });
  useEffect(() => {
    if (!failed) return undefined;
    const again = () => latest.current?.();
    window.addEventListener('online', again);
    window.addEventListener('focus', again);
    return () => {
      window.removeEventListener('online', again);
      window.removeEventListener('focus', again);
    };
  }, [failed]);
};
