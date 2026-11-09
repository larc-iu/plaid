// The sample rates of the staged recordings, read from their headers as they
// arrive (mediaSampleRate.js), for the size a mix of several would come to.
// A file whose header does not say is remembered as null rather than asked
// again on every render, and the size then takes the fallback rate.

import { useEffect, useState } from 'react';
import { readSampleRate } from '@/domain/media/mediaSampleRate';

export function useMediaSampleRates(files) {
  const [rates, setRates] = useState(() => new Map());

  useEffect(() => {
    let alive = true;
    const wanted = (files || []).filter((f) => !rates.has(f));
    if (!wanted.length) return undefined;
    Promise.all(wanted.map(async (file) => [file, await readSampleRate(file)])).then((pairs) => {
      if (!alive) return;
      setRates((prev) => {
        const next = new Map(prev);
        for (const [file, rate] of pairs) next.set(file, rate);
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [files, rates]);

  return rates;
}
