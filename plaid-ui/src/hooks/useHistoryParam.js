import { useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

// The history entry open on a screen with a History rail, kept in the URL
// (`?history=<entry id>`), and how it is shown (`?historyView=document` for
// the state after it, nothing for what it changed). So a link can open an
// entry (a job's page links to its entry in each document), a reload keeps
// it, and Back steps out of it.
//
// The screen keeps its own selection, which an async read settles, and this
// keeps the two in step without a loop. Whichever of them moved since the last
// render is the one that is followed:
// - the URL moved (a link, Back, a pasted address): `open(id)` is asked to
//   select that entry, or nothing for null. It reads what it needs and selects
//   it, or calls `clear()` when there is no such entry.
// - the selection moved on its own (a restore left the past, a read failed and
//   put the old entry back, the rail was closed): the URL is set to it, in
//   place, since the reader did not ask for an address.
// A pick in the rail moves both at once (`select(id)` beside the screen's own
// select), which pushes a history entry, as opening any detail does.
//
// `ready`: false until the screen can select anything (its document loaded).
// A new entry always opens on what it changed: picking one drops the view.
const HISTORY_PARAM = 'history';
const HISTORY_VIEW_PARAM = 'historyView';

const write = (prev, id) => {
  const next = new URLSearchParams(prev);
  if (id) next.set(HISTORY_PARAM, id);
  else next.delete(HISTORY_PARAM);
  next.delete(HISTORY_VIEW_PARAM);
  return next;
};

export function useHistoryParam({ selectedId, ready, open }) {
  const [params, setParams] = useSearchParams();
  const wanted = params.get(HISTORY_PARAM);
  const view = params.get(HISTORY_VIEW_PARAM) === 'document' ? 'document' : 'changes';
  const seen = useRef({ wanted: undefined, selected: undefined });
  const openRef = useRef(open);
  openRef.current = open;

  const selected = selectedId ?? null;
  useEffect(() => {
    if (!ready) return;
    const prev = seen.current;
    seen.current = { wanted, selected };
    if (wanted === selected) return;
    if (wanted !== prev.wanted) {
      openRef.current?.(wanted);
      return;
    }
    if (selected !== prev.selected) setParams((p) => write(p, selected), { replace: true });
  }, [ready, wanted, selected, setParams]);

  const select = useCallback((id) => setParams((p) => write(p, id)), [setParams]);
  const clear = useCallback(() => setParams((p) => write(p, null), { replace: true }), [setParams]);
  const setView = useCallback(
    (next) =>
      setParams((p) => {
        const out = new URLSearchParams(p);
        if (next === 'document') out.set(HISTORY_VIEW_PARAM, 'document');
        else out.delete(HISTORY_VIEW_PARAM);
        return out;
      }),
    [setParams],
  );
  return { wanted, view, select, clear, setView };
}

/** The address of the page at `path` with History entry `entryId` open. */
export const historyHref = (path, entryId) =>
  `${path}?${new URLSearchParams({ [HISTORY_PARAM]: entryId })}`;
