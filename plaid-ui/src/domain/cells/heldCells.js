// The cell engines of an open document, kept for as long as the document is
// open rather than for as long as a grid is drawn. A grid is drawn again
// after a history entry was on screen in its place, after a tab switch, or
// when its island is rebuilt, and a value put back unsent or a conflict
// waiting for keep-yours belongs to the document, not to that drawing. One
// engine per document object and per grid (`name`: igt's Analyze grid and
// its transcript rows read their cells differently), made on first ask. The
// shell lets them go when the document closes (`releaseCellEngines`).

const held = new WeakMap();

/** The engine `name` of `doc`, made by `make()` the first time it is asked for. */
export const heldCellEngine = (doc, name, make) => {
  let engines = held.get(doc);
  if (!engines) {
    engines = new Map();
    held.set(doc, engines);
  }
  let engine = engines.get(name);
  if (!engine) {
    engine = make();
    engines.set(name, engine);
  }
  return engine;
};

/** Let go of everything `doc`'s engines hold: the document is closed. */
export const releaseCellEngines = (doc) => {
  const engines = doc && held.get(doc);
  if (!engines) return;
  held.delete(doc);
  for (const engine of engines.values()) engine.clear();
};
