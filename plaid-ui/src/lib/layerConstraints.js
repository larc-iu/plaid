// The declaration of an app's layer rules (plaid-core's layer constraints),
// shared by every app. Each app builds the list it wants for each layer it
// owns from its layer info (a pure `wantedConstraints`), and a maintainer's
// open hands it here: a layer whose stored list differs is checked, repaired
// first when the check finds data its rules with a remedy would change (the
// same deletions the old open-time heals made, once, project-wide), then
// declared. A rule the stored data still breaks (one with no remedy: two
// heads on a word, a cycle, an off-list value, or a repair a lock held off)
// is refused by the server. The layer is then declared with the rest of its
// list, and the refused rules are returned under `pending` for the app's
// validator to report. A later open checks only those rules, and declares
// them once the data no longer breaks them.
//
// A writer's open of a layer that holds none of the app's rules yet repairs
// the document being opened, as the old heals did, and declares nothing.

import { isConstraintViolation, statusOf } from './errors.js';
import { violationsOf } from '../../../plaid-client-js/src/constraints.js';

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
export const sameConstraints = (a, b) =>
  JSON.stringify(canonical(a?.length ? a : [])) === JSON.stringify(canonical(b?.length ? b : []));

const sameRule = (a, b) => sameConstraints([a], [b]);

/**
 * Queue on batch `b`, ahead of a settings save's declaration on a layer that
 * holds none of the app's rules yet, the repair of what core can repair (a
 * doubled annotation, say), as a maintainer's open would have done. Then only
 * a violation with no remedy refuses the save. True when it queued one.
 */
export const queueRepairOfBareLayer = (b, { kind, layerId, constraints, stored }) => {
  if (stored?.length || !constraints?.some((c) => REMEDIABLE.has(c.type))) return false;
  b[BUNDLE[kind]].repairConstraints(layerId, constraints);
  return true;
};

/** The list a layer read holds for `namespace`, or null. */
export const storedConstraints = (layer, namespace) => layer?.constraints?.[namespace] ?? null;

const countOf = (answer) =>
  answer?.violationCount ?? answer?.['violation-count'] ?? answer?.violations?.length ?? 0;

const typesOf = (violations) => [...new Set((violations || []).map((v) => v.constraint))];

/**
 * The rules of `entry` still out when its layer holds part of the list it
 * wants (an earlier open declared the rest), else null.
 */
const stillOut = (entry) => {
  const stored = entry.stored || [];
  if (!stored.length) return null;
  if (!stored.every((s) => entry.constraints.some((c) => sameRule(s, c)))) return null;
  return entry.constraints.filter((c) => !stored.some((s) => sameRule(s, c)));
};

/**
 * What a maintainer's open does for one entry: the list to declare, the list
 * to repair first, and the rules left pending. Reads only: the rules with a
 * remedy are repaired only when a check finds the stored data breaks them
 * (H9-FIRST-OPEN-3: a repair holds the write lock for the whole layer, and
 * clean data is the rule). The rules an earlier open left out that have no
 * remedy are checked for `pending`.
 */
const planOf = async (client, entry) => {
  const out = stillOut(entry);
  const check = (rules) => client[BUNDLE[entry.kind]].checkConstraints(entry.layerId, rules);
  const fixable = (out ?? entry.constraints).filter((c) => REMEDIABLE.has(c.type));
  // Every rule with a remedy is repaired when any is broken: the check lists
  // at most 100 violations, so their types do not say which are.
  const repair = fixable.length && countOf(await check(fixable)) > 0 ? fixable : [];
  if (!out) return { entry, target: entry.constraints, repair, pending: null };
  const unfixable = out.filter((c) => !REMEDIABLE.has(c.type));
  let broken = [];
  let count = 0;
  if (unfixable.length) {
    const answer = await check(unfixable);
    count = countOf(answer);
    broken = typesOf(answer?.violations);
    if (count && !broken.length) broken = unfixable.map((c) => c.type);
  }
  const keep = (c) => !broken.includes(c.type);
  return {
    entry,
    target: entry.constraints.filter(keep),
    repair,
    pending: broken.length ? { constraints: broken, violationCount: count } : null,
  };
};

// What a rule of a layer of each kind is kept on, for the finding.
const ROW_WORDS = {
  token: ['token', 'tokens'],
  span: ['value', 'values'],
  relation: ['relation', 'relations'],
};

/**
 * One validator finding per layer whose rules are not in force (`pending`
 * from ensureLayerConstraints): the server refused the declaration because
 * stored data breaks a rule it has no repair for. `layers` are the app's
 * layer reads, for their names. Written for the console and the copied
 * details, like every finding.
 */
export const rulesNotInForce = (pending, layers) =>
  (pending || []).map((p) => {
    const name = (layers || []).find((l) => l?.id === p.layerId)?.name ?? p.layerId;
    const n = p.violationCount;
    const [one, many] = ROW_WORDS[p.kind] ?? ['row', 'rows'];
    return {
      severity: 'warning',
      code: 'layer-rules-not-in-force',
      message: `The ${p.constraints.join(' and ')} rules of "${name}" are not in force: ${n} stored ${n === 1 ? `${one} breaks` : `${many} break`} them.`,
      context: p,
    };
  });

const pendingEntry = (entry, constraints, violationCount) => ({
  layerId: entry.layerId,
  kind: entry.kind,
  namespace: entry.namespace,
  constraints,
  violationCount,
});

/**
 * Declare the rules in `wanted` whose stored list differs.
 *
 * @param {object} client - a PlaidClient
 * @param {Array<{kind: 'token'|'span'|'relation', layerId: string, namespace: string,
 *   constraints: Array<object>, stored: Array<object>|null}>} wanted
 * @param {{canManage?: boolean, canWrite?: boolean, documentId?: string}} options -
 *   a maintainer declares. A writer, given the document being opened,
 *   repairs it for the layers that hold none of the rules yet.
 * @returns {Promise<{changed: boolean, repaired: boolean, pending: Array<object>}>}
 *   `changed` when a list was declared, `repaired` when stored data was
 *   changed (the caller reloads), `pending` for each layer with rules left
 *   undeclared, naming them.
 */
export async function ensureLayerConstraints(
  client,
  wanted,
  { canManage = false, canWrite = false, documentId = null } = {},
) {
  const result = { changed: false, repaired: false, pending: [] };
  if (!canManage) {
    if (canWrite && documentId) result.repaired = await repairDocument(client, wanted, documentId);
    return result;
  }
  const differs = wanted.filter((w) => !sameConstraints(w.stored, w.constraints));
  if (!differs.length) return result;

  // Reads only: each layer is checked before anything is written, so clean
  // data is declared with no repair, and a layer the data still breaks costs
  // its checks.
  const plans = [];
  for (const w of differs) plans.push(await planOf(client, w));
  const pendingOf = new Map();
  for (const p of plans) if (p.pending) pendingOf.set(p.entry.layerId, { ...p.pending });
  const toDeclare = plans.filter((p) => !sameConstraints(p.entry.stored, p.target));

  if (toDeclare.length) {
    await client.withOperation(
      'Set up layer rules',
      async () => {
        const toRepair = toDeclare.filter((p) => p.repair.length);
        if (toRepair.length) {
          const answers = await client.batched((b) =>
            toRepair.forEach((p) =>
              b[BUNDLE[p.entry.kind]].repairConstraints(p.entry.layerId, p.repair),
            ),
          );
          // A batch answers `{status, headers, body}` per operation.
          result.repaired = (answers || []).some((a) => (a?.body ?? a)?.repaired?.length > 0);
        }

        const declare = (api, w, list) =>
          api[BUNDLE[w.kind]].setConstraints(w.layerId, w.namespace, list, undefined, {
            expected: w.stored ?? null,
          });
        if (toDeclare.length > 1) {
          try {
            await client.batched((b) => toDeclare.forEach((p) => declare(b, p.entry, p.target)));
            result.changed = true;
            return;
          } catch (e) {
            if (!isConstraintViolation(e) && statusOf(e) !== 409) throw e;
          }
        }
        // One layer, or one refusal rolled the whole batch back: declare each
        // on its own, taking out the rules each refusal names, to declare the
        // rest.
        for (const { entry: w, target } of toDeclare) {
          let list = target;
          // The first refusal counts every violation of the rules refused.
          let counted = false;
          while (list.length && !sameConstraints(w.stored, list)) {
            try {
              await declare(client, w, list);
              result.changed = true;
              break;
            } catch (e) {
              if (isConstraintViolation(e)) {
                const named = typesOf(violationsOf(e));
                const held = pendingOf.get(w.layerId) ?? { constraints: [], violationCount: 0 };
                if (!counted) held.violationCount += countOf(e.responseData);
                counted = true;
                for (const t of named) if (!held.constraints.includes(t)) held.constraints.push(t);
                pendingOf.set(w.layerId, held);
                const next = list.filter((c) => !named.includes(c.type));
                if (next.length === list.length) break;
                list = next;
              } else if (statusOf(e) === 409) {
                // Another maintainer declared meanwhile. Theirs stands, and
                // this open does not write over it.
                await client[BUNDLE[w.kind]].get(w.layerId);
                break;
              } else {
                throw e;
              }
            }
          }
        }
      },
      { kind: 'repair' },
    );
  }
  for (const p of plans) {
    const held = pendingOf.get(p.entry.layerId);
    if (held) result.pending.push(pendingEntry(p.entry, held.constraints, held.violationCount));
  }
  return result;
}

/**
 * A writer's open: repair document `documentId` for every layer in `wanted`
 * that holds none of its rules yet. Answers whether anything was changed.
 */
async function repairDocument(client, wanted, documentId) {
  const bare = wanted.filter(
    (w) => !w.stored?.length && w.constraints.some((c) => REMEDIABLE.has(c.type)),
  );
  if (!bare.length) return false;
  // One batch, so History shows the repairs as one step.
  const answers = await client.batched((b) =>
    bare.forEach((w) =>
      b[BUNDLE[w.kind]].repairConstraints(w.layerId, w.constraints, undefined, {
        document: documentId,
      }),
    ),
  );
  return (answers || []).some((a) => (a?.body ?? a)?.repaired?.length > 0);
}
