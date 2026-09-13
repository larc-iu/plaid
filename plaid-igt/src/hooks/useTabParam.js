import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

// Keeps a tab group's selection in the URL query string (`?tab=analyze`) so a
// refresh, a shared link, and the browser back button all land on the same tab.
//
// `tabs` is the list of legal values and `fallback` the one shown when the
// param is absent or unrecognized (Radix renders an empty body for a value with
// no matching trigger, so an unknown value has to fall back rather than pass
// through). The fallback is never written to the URL, which keeps the plain
// page link clean.
//
// `writeFallback` turns that off, for a group where the bare page does NOT mean
// the fallback tab. The document editor is the one: no param there means "no
// tab chosen", which is what lets it land on Analyze for a tokenized document,
// so Metadata has to write itself like any other tab or its own address is a
// URL that opens Analyze.
//
// The setter takes the same options as `setSearchParams`. Pass
// `{ replace: true }` for a switch the user did not ask for, such as an
// automatic landing tab, so it does not add a history entry to back out of.
export const useTabParam = (tabs, fallback, param = 'tab', writeFallback = false) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(param);
  const active = tabs.includes(raw) ? raw : fallback;

  const setActive = useCallback(
    (value, options) => {
      setSearchParams((prev) => {
        // Copy so the other params on the page (`?item=`, `?focusSentence=`)
        // survive a tab switch.
        const next = new URLSearchParams(prev);
        if (!value || (value === fallback && !writeFallback)) next.delete(param);
        else next.set(param, value);
        return next;
      }, options);
    },
    [setSearchParams, fallback, param, writeFallback],
  );

  // A value that names no tab is dropped from the URL, in place. Without this
  // the address kept saying `?tab=validation` while the Documents tab was on
  // screen, and the wrong half is the half that gets copied to a colleague.
  // The real slugs are short (`validate`, `bulk`), so guessing one from a tab's
  // label is the ordinary way to arrive here.
  useEffect(() => {
    if (raw !== null && !tabs.includes(raw)) setActive(fallback, { replace: true });
  }, [raw, tabs, fallback, setActive]);

  return [active, setActive];
};

// The link for one tab of a group whose selection lives in the query string.
// The fallback tab is the bare page, matching what the setter writes, unless
// the group writes its fallback too (see `writeFallback`).
export const tabTo = (basePath, value, fallback, param = 'tab', writeFallback = false) =>
  value === fallback && !writeFallback ? basePath : `${basePath}?${param}=${value}`;
