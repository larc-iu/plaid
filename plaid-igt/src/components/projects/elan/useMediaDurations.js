// The durations of the staged recordings, filled in as they are read.
//
// Each is a header read (see readDuration), so a batch of thirty resolves in
// about as long as one. A file whose duration cannot be read is remembered as
// null rather than retried on every render.

import { useEffect, useState } from 'react';
import { readDuration } from '@/domain/media/mediaDuration';

export function useMediaDurations(files) {
  const [durations, setDurations] = useState(() => new Map());

  useEffect(() => {
    let alive = true;
    const wanted = (files || []).filter((f) => !durations.has(f));
    if (!wanted.length) return undefined;
    Promise.all(wanted.map(async (file) => [file, await readDuration(file)])).then((pairs) => {
      if (!alive) return;
      setDurations((prev) => {
        const next = new Map(prev);
        for (const [file, seconds] of pairs) next.set(file, seconds);
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [files, durations]);

  return durations;
}
