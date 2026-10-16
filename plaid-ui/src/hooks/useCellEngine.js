import { useEffect, useMemo, useRef } from 'react';
import { CellEngine } from '../domain/cells/CellEngine.js';
import { heldCellEngine } from '../domain/cells/heldCells.js';

// The React side of the cell engine (domain/cells/CellEngine.js): one engine
// per document, which every cell of a grid shares, so a value put back for a
// cell outlives the cell (a page turned away from, the grid drawn again) and
// still counts as typed and not saved.

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
 * The engine `name` of `doc`'s grid. `read`, `shape`, `recut`, `describe`,
 * `entityIds` and `announce` are CellEngine's, read through a ref so a new
 * closure each render is fine. Every change to the document's data is gone
 * over (`reconcile`). The engine is the document's (domain/cells/
 * heldCells.js): a grid drawn again, after a history entry was on screen in
 * its place or a tab switch, finds every value it held, and the shell lets
 * it go with the document.
 */
export function useCellEngine(doc, options, name = 'grid') {
  const opts = useRef(options);
  opts.current = options;
  const engine = useMemo(() => {
    if (!doc) return reactCellEngine({ read: () => undefined });
    const held = heldCellEngine(doc, name, () => reactCellEngine({}));
    // The drawing now on screen reads for it.
    return held.bind({
      read: (key) => opts.current.read(key),
      shape: (key) => opts.current.shape?.(key) ?? null,
      recut: (snapshot, key) => opts.current.recut?.(snapshot, key) ?? null,
      describe: (key) => opts.current.describe?.(key) ?? null,
      entityIds: (key) => opts.current.entityIds?.(key) ?? [],
      announce: (event) => opts.current.announce?.(event),
    });
    // One per document: another document is another grid.
  }, [doc, name]);
  const dataVersion = doc?.dataVersion ?? 0;
  useEffect(() => {
    if (engine.size) engine.reconcile();
  }, [engine, dataVersion]);
  return engine;
}
