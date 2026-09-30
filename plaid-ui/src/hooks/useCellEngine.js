import { useEffect, useMemo, useRef } from 'react';
import { CellEngine } from '../domain/cells/CellEngine.js';

// The React side of the cell engine (domain/cells/CellEngine.js): one engine
// per document, which every cell of a grid shares, so a value put back for a
// cell outlives the cell (a page turned away from) and still counts as typed
// and not saved.

// Each engine's drawn cells, by canonical key: what `useConflictCell` registers.
const drawn = new WeakMap();

/** Register the drawn cell `key` of `engine`. Answers the unregister. */
export const drawCell = (engine, key, view) => {
  const views = drawn.get(engine);
  const k = engine.canonical(key);
  views.set(k, view);
  return () => {
    if (views.get(k) === view) views.delete(k);
  };
};

/** A new engine whose drawn cells `drawCell` registers. */
export const reactCellEngine = (options) => {
  const views = new Map();
  const engine = new CellEngine({ ...options, view: (_key, k) => views.get(k) ?? null });
  drawn.set(engine, views);
  return engine;
};

/**
 * One engine for `doc`'s grid. `read`, `shape`, `recut`, `describe`,
 * `entityIds` and `announce` are CellEngine's, read through a ref so a new
 * closure each render is fine. Every change to the document's data is gone
 * over (`reconcile`), and the engine is let go with the grid.
 */
export function useCellEngine(doc, options) {
  const opts = useRef(options);
  opts.current = options;
  const engine = useMemo(
    () =>
      reactCellEngine({
        read: (key) => opts.current.read(key),
        shape: (key) => opts.current.shape?.(key) ?? null,
        recut: (snapshot, key) => opts.current.recut?.(snapshot, key) ?? null,
        describe: (key) => opts.current.describe?.(key) ?? null,
        entityIds: (key) => opts.current.entityIds?.(key) ?? [],
        announce: (event) => opts.current.announce?.(event),
      }),
    // One per document: another document is another grid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc],
  );
  useEffect(() => () => engine.clear(), [engine]);
  const dataVersion = doc?.dataVersion ?? 0;
  useEffect(() => {
    if (engine.size) engine.reconcile();
  }, [engine, dataVersion]);
  return engine;
}
