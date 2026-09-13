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
// The options, all of them rare:
//
// `param` is the query key, for a second group on one page (`op`, `pane`).
//
// `writeFallback` turns off "the fallback is the bare page", for a group where
// the bare page does NOT mean the fallback tab. The document editor is the one:
// no param there means "no tab chosen", which is what lets it land on Analyze
// for a tokenized document, so Metadata has to write itself like any other tab
// or its own address is a URL that opens Analyze.
//
// `aliases` maps a spelling someone would reasonably type onto the slug that
// group actually uses. A tab labelled Validation lives at `?tab=validate` and
// Bulk Edit at `?tab=bulk`, so typing the label is the ordinary way to arrive,
// and it used to land on Documents. An alias resolves AND rewrites, so the
// address ends up saying the slug the app writes itself.
//
// `ready` is false while `tabs` can still GROW. A group whose membership
// depends on data (the vocabulary's tabs, which need the viewer's rights)
// starts short, and correcting the URL against the short list threw away a
// perfectly good `?tab=settings` before it became legal. Nothing else can
// know that from in here, so the caller says.
//
// The setter takes the same options as `setSearchParams`. Pass
// `{ replace: true }` for a switch the user did not ask for, such as an
// automatic landing tab, so it does not add a history entry to back out of.
export const useTabParam = (
  tabs,
  fallback,
  { param = 'tab', writeFallback = false, aliases, ready = true } = {},
) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(param);
  // An alias only counts when what it names is a tab of this group. A group
  // that narrows by the reader's rights does not carry every slug its aliases
  // point at, and without this check `?tab=validation` resolved to a tab with
  // no trigger, which Radix renders as an empty body.
  const aliased = aliases?.[raw];
  const named = tabs.includes(raw) ? raw : tabs.includes(aliased) ? aliased : null;
  const active = named ?? fallback;

  const setActive = useCallback(
    (value, options) => {
      setSearchParams((prev) => writeTab(prev, value, fallback, param, writeFallback), options);
    },
    [setSearchParams, fallback, param, writeFallback],
  );

  // The href for one tab of this group, for a trigger that is also a link.
  // It keeps the rest of the query string, exactly as the setter does, so
  // middle-clicking a tab opens the search the reader was looking at rather
  // than a bare list.
  const tabHref = useCallback(
    (basePath, value) => {
      const q = writeTab(searchParams, value, fallback, param, writeFallback).toString();
      return q ? `${basePath}?${q}` : basePath;
    },
    [searchParams, fallback, param, writeFallback],
  );

  // A value that is not already the slug is rewritten in place: to the tab it
  // is an alias for, or, when it names nothing, dropped. Without this the
  // address kept saying `?tab=validation` while the Documents tab was on
  // screen, and the wrong half is the half that gets copied to a colleague.
  useEffect(() => {
    if (!ready || raw === null || tabs.includes(raw)) return;
    setActive(named ?? fallback, { replace: true });
  }, [ready, raw, tabs, named, fallback, setActive]);

  return [active, setActive, tabHref];
};

// The query string for one tab of a group, keeping every other param.
// `?item=`, `?focusSentence=` and a project search's `?q=&match=&in=&mode=`
// all survive a tab switch, and the fallback tab is the bare page unless the
// group writes its fallback too (see `writeFallback`).
const writeTab = (current, value, fallback, param, writeFallback) => {
  const next = new URLSearchParams(current);
  if (!value || (value === fallback && !writeFallback)) next.delete(param);
  else next.set(param, value);
  return next;
};

// The same link for a group whose page carries nothing else in its query
// string. Prefer the hook's `tabHref`, which keeps whatever else is there.
export const tabTo = (basePath, value, fallback, param = 'tab', writeFallback = false) => {
  const q = writeTab(null, value, fallback, param, writeFallback).toString();
  return q ? `${basePath}?${q}` : basePath;
};
