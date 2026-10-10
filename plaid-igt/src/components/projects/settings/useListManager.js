import { useState, useEffect } from 'react';
import { notifyError } from '@/utils/feedback';

/** `list` with the item at `from` moved to `to`. */
export const moveItem = (list, from, to) => {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
};

// The list a settings or setup manager edits, stored under `listKey` in the
// data its parent hands down and saves. With no list in `initialData` it is
// read through `onLoadData`, and failing that it is `defaults()`, which the
// setup wizard (`autoSaveDefaults`) saves at once so its review shows them.
// A load that fails shows the defaults. `noun` names the list in errors.
export const useListManager = ({
  listKey,
  noun,
  defaults,
  initialData,
  onLoadData,
  onSaveChanges,
  onError,
  autoSaveDefaults = false,
}) => {
  const [items, setItems] = useState([]);
  const [isInitialized, setIsInitialized] = useState(false);

  const report = (error, title) => {
    if (onError) onError(error);
    else notifyError(error, title);
  };

  useEffect(() => {
    const load = async () => {
      try {
        let data = initialData;
        if (!data && onLoadData) data = await onLoadData();
        const usedDefaults = !data?.[listKey];
        if (usedDefaults) data = { [listKey]: defaults() };
        setItems(data[listKey]);
        setIsInitialized(true);
        if (usedDefaults && autoSaveDefaults && onSaveChanges) await onSaveChanges(data);
      } catch (error) {
        console.error(`Failed to load the ${noun}:`, error);
        setItems(defaults());
        setIsInitialized(true);
        report(error, `Failed to load the ${noun}`);
      }
    };
    load();
    // Runs once per initialData; the callbacks are read fresh and must not
    // start another load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialData]);

  const save = async (next) => {
    try {
      if (onSaveChanges) await onSaveChanges({ [listKey]: next });
      setItems(next);
    } catch (error) {
      console.error(`Failed to save the ${noun}:`, error);
      report(error, `Failed to save the ${noun}`);
    }
  };

  const move = async (from, to) => {
    if (from < 0 || to < 0 || to >= items.length) return;
    await save(moveItem(items, from, to));
  };

  return { items, setItems, isInitialized, save, move, report };
};
