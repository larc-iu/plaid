import { useCallback } from 'react';
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
// The setter takes the same options as `setSearchParams`. Pass
// `{ replace: true }` for a switch the user did not ask for, such as an
// automatic landing tab, so it does not add a history entry to back out of.
export const useTabParam = (tabs, fallback, param = 'tab') => {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(param);
  const active = tabs.includes(raw) ? raw : fallback;

  const setActive = useCallback(
    (value, options) => {
      setSearchParams((prev) => {
        // Copy so the other params on the page (`?item=`, `?focusSentence=`)
        // survive a tab switch.
        const next = new URLSearchParams(prev);
        if (!value || value === fallback) next.delete(param);
        else next.set(param, value);
        return next;
      }, options);
    },
    [setSearchParams, fallback, param],
  );

  return [active, setActive];
};

// The link for one tab of a group whose selection lives in the query string.
// The fallback tab is the bare page, matching what the setter writes.
export const tabTo = (basePath, value, fallback, param = 'tab') =>
  value === fallback ? basePath : `${basePath}?${param}=${value}`;
