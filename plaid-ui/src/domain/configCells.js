import { statusOf } from '../lib/errors.js';

// Settings pages write config one cell at a time: one `namespace/key` on a
// project or a layer. Each write names the value the page read for that cell
// as `expected`, and the server refuses it with a 409 when another save came
// in between. So a page opened before someone else saved cannot write over
// that save. A page writes only the cells its user changed, and on a 409 it
// reads the project again and says so.

/** The value stored in one cell of a project's or layer's config, or
 * undefined when the cell is absent (the client sends that as null). */
export const storedConfig = (entity, namespace, key) => entity?.config?.[namespace]?.[key];

/** The write options that expect a cell to still hold what `entity` holds. */
export const expectStored = (entity, namespace, key) => ({
  expected: storedConfig(entity, namespace, key),
});

/** A write refused because the cell changed since it was read. */
export const isConfigConflict = (error) => statusOf(error) === 409;

// JSON with every object's keys in order, which is how the server compares
// two config values.
const canonical = (value) =>
  JSON.stringify(value ?? null, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );

/** Whether two config values are the same, whatever order their keys are in.
 * Absent and null are the same. */
export const sameConfig = (a, b) => canonical(a) === canonical(b);
