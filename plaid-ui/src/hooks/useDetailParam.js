import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

// The open item of a master-detail screen, kept in the URL (`?user=<id>`,
// `?guideline=<id>`) beside every other param, so a row can be a real link,
// a reload or a pasted address opens the same item, and Back steps through
// the items opened one after another. `useTabParam` is the same for a tab.
//
// Returns `[id, set, hrefFor]`. `set(id, options, extra)` opens `id`, or
// closes the detail for a null `id`. It pushes a history entry: pass
// `{ replace: true }` for a change the user did not ask for (the item they
// had open was deleted, or a new one got its id). `hrefFor(id, extra)` is the
// `to` of a link that opens `id` with every other param kept.
//
// `companions` names params that ride with one item, such as the parent a
// new entry is made under (`?item=new&parent=<id>`). They are dropped
// whenever the detail changes, unless `extra` sets them again.
export const useDetailParam = (name, { companions } = {}) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const set = useCallback(
    (id, options, extra) =>
      setSearchParams((prev) => writeDetail(prev, name, id, companions, extra), options),
    [setSearchParams, name, companions],
  );
  const hrefFor = useCallback(
    (id, extra) => {
      const q = writeDetail(searchParams, name, id, companions, extra).toString();
      return { search: q ? `?${q}` : '' };
    },
    [searchParams, name, companions],
  );
  return [searchParams.get(name), set, hrefFor];
};

const writeDetail = (current, name, id, companions, extra) => {
  const next = new URLSearchParams(current);
  if (id) next.set(name, id);
  else next.delete(name);
  for (const key of companions || []) next.delete(key);
  for (const [key, value] of Object.entries(extra || {})) {
    if (value != null && value !== '') next.set(key, value);
  }
  return next;
};
