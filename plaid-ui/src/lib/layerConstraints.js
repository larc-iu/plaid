// The declaration of an app's layer rules (plaid-core's layer constraints),
// shared by every app. Each app builds the list it wants for each layer it
// owns from its layer info (a pure `wantedConstraints`), and a maintainer's
// open hands it here: a layer whose stored list differs is repaired first
// (the same deletions the old open-time heals made, once, project-wide), then
// declared. A declaration the stored data still breaks (a rule with no
// remedy: two heads on a word, a cycle, an off-list value) is refused by the
// server and the layer stays undeclared, returned under `pending` for the
// app's validator to report.

import { isConstraintViolation, statusOf } from './errors.js';

const REMEDIABLE = new Set(['coextensive', 'single-span', 'single-link', 'same-ancestor']);

const BUNDLE = { token: 'tokenLayers', span: 'spanLayers', relation: 'relationLayers' };

// A value with every object's keys in order, so two lists that differ only in
// key order compare equal.
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  }
  return value;
};

/** Whether two constraint lists are the same (absent and empty alike). */
const sameConstraints = (a, b) =>
  JSON.stringify(canonical(a?.length ? a : [])) === JSON.stringify(canonical(b?.length ? b : []));

/** The list a layer read holds for `namespace`, or null. */
export const storedConstraints = (layer, namespace) => layer?.constraints?.[namespace] ?? null;

const pendingOf = (entry, error) => ({
  layerId: entry.layerId,
  kind: entry.kind,
  namespace: entry.namespace,
  constraints: [...new Set(error.responseData.violations.map((v) => v.constraint))],
  violationCount: error.responseData['violation-count'] ?? error.responseData.violations.length,
});

/**
 * Declare the rules in `wanted` whose stored list differs.
 *
 * @param {object} client - a PlaidClient
 * @param {Array<{kind: 'token'|'span'|'relation', layerId: string, namespace: string,
 *   constraints: Array<object>, stored: Array<object>|null}>} wanted
 * @param {{canManage?: boolean}} options - only a maintainer declares
 * @returns {Promise<{changed: boolean, repaired: boolean, pending: Array<object>}>}
 *   `changed` when a list was declared, `repaired` when stored data was
 *   changed (the caller reloads), `pending` for each layer left undeclared.
 */
export async function ensureLayerConstraints(client, wanted, { canManage = false } = {}) {
  const result = { changed: false, repaired: false, pending: [] };
  if (!canManage) return result;
  const differs = wanted.filter((w) => !sameConstraints(w.stored, w.constraints));
  if (!differs.length) return result;

  await client.withOperation(
    'Set up layer rules',
    async () => {
      const toRepair = differs.filter((w) => w.constraints.some((c) => REMEDIABLE.has(c.type)));
      if (toRepair.length) {
        const answers = await client.batched((b) =>
          toRepair.forEach((w) => b[BUNDLE[w.kind]].repairConstraints(w.layerId, w.constraints)),
        );
        // A batch answers `{status, headers, body}` per operation.
        result.repaired = (answers || []).some((a) => (a?.body ?? a)?.repaired?.length > 0);
      }

      const declare = (api, w) =>
        api[BUNDLE[w.kind]].setConstraints(w.layerId, w.namespace, w.constraints, undefined, {
          expected: w.stored ?? null,
        });
      try {
        await client.batched((b) => differs.forEach((w) => declare(b, w)));
        result.changed = true;
        return;
      } catch (e) {
        if (!isConstraintViolation(e) && statusOf(e) !== 409) throw e;
      }
      // One refusal rolled the whole batch back: declare each on its own to
      // learn which layers the stored data still breaks.
      for (const w of differs) {
        try {
          await declare(client, w);
          result.changed = true;
        } catch (e) {
          if (isConstraintViolation(e)) {
            result.pending.push(pendingOf(w, e));
          } else if (statusOf(e) === 409) {
            // Another maintainer declared meanwhile. Read it once: theirs
            // stands, and this open does not write over it.
            const layer = await client[BUNDLE[w.kind]].get(w.layerId);
            if (!sameConstraints(storedConstraints(layer, w.namespace), w.constraints)) continue;
          } else {
            throw e;
          }
        }
      }
    },
    { kind: 'repair' },
  );
  return result;
}
