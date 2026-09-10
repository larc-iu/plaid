import { useCallback, useEffect, useRef, useState } from 'react';
import { appPrefix } from '../lib/uiConfig.js';

// View state that outlives the mount: how a list is sorted, which page of it
// was open. It lives in localStorage rather than on the account because it
// describes a screen and not a person. Reading it costs no round trip, so the
// first paint is already the list the reader left, and a sort order is not
// something anyone wants carried between machines.
//
// Storage is untrusted input. Every stored value passes `accept` before it
// reaches a render, and anything rejected falls back to the default: a sort on
// a lexicon field that has since been renamed would otherwise reach a
// comparator with no extractor for it and throw. Nothing here migrates an
// older shape; `accept` rejects it and the list opens at its default.

/**
 * The storage key for one list's `what`, scoped to `id` where a list has one.
 *
 * The app prefix comes from `configureUi` rather than being a constant here:
 * both apps have a document list, and a sort order remembered for one of them
 * must not decide how the other's opens. plaid-igt passes `plaid_igt`, which is
 * the prefix these keys have always carried there.
 */
export const listPrefKey = (what, list, id) =>
  `${appPrefix()}_list_${what}:${list}${id ? `:${id}` : ''}`;

const read = (key, initial, accept) => {
  if (!key) return initial;
  let raw;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return initial; // storage off, or a private window
  }
  if (raw === null) return initial;
  try {
    const value = JSON.parse(raw);
    return accept && !accept(value) ? initial : value;
  } catch {
    return initial;
  }
};

/**
 * `useState`, remembered under `key`. A null key opts out and leaves plain
 * state behind, which is what an unscoped caller passes.
 */
export const useStickyState = (key, initial, accept) => {
  const [value, setValue] = useState(() => read(key, initial, accept));

  // The key changes when the reader moves to another project or vocabulary
  // without the list unmounting. Re-seed during the render that brings the new
  // key, so the first paint of that list is already its own state.
  const seeded = useRef(key);
  if (seeded.current !== key) {
    seeded.current = key;
    setValue(read(key, initial, accept));
  }

  useEffect(() => {
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Full, or storage is off. The list works, it just forgets.
    }
  }, [key, value]);

  return [value, setValue];
};

const isSort = (columns) => (v) =>
  !!v && columns.includes(v.key) && (v.dir === 'asc' || v.dir === 'desc');

/**
 * A list's sort order, remembered, with the toggle every sortable list shares:
 * the active column flips direction, a new column starts ascending. `columns`
 * are the keys the list can sort by, which is both what its <SortHeader>s name
 * and what a stored value is checked against.
 */
export const useStickySort = (key, initial, columns) => {
  const [sort, setSort] = useStickyState(key, initial, isSort(columns));
  const onSort = useCallback(
    (field) =>
      setSort((prev) =>
        prev.key === field
          ? { key: field, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
          : { key: field, dir: 'asc' },
      ),
    [setSort],
  );
  return [sort, onSort];
};
