// The morph type cached on morphemes linked to lexicon entries.
//
// A linked morpheme goes by its entry's type (its own, else its headword's:
// vocabDictionary `morphTypeOf`), and keeps a copy in `metadata.morphType`
// for the readers that do not load the lexicon: queries, exports, the
// assistant, other apps. Every write that changes the type an entry goes by
// (its own type, its place under a headword, the headword's type, a merge
// that moves its links) writes that copy on every morpheme linked to it, in
// every project the writer can write, in the same operation. Nothing repairs
// a stale copy later.
//
// Relative imports only: the one-off script that fixes caches runs this from
// plain node.

import { buildSenseTree, morphTypeOf } from './vocabDictionary.js';
import { CHUNK } from './bulk.js';
import { canEditProject } from '../../../plaid-ui/src/domain/permissions.js';

const isType = (t) => typeof t === 'string' && t !== '';

/**
 * The type each of `rootIds` and every entry below it in the sense tree goes
 * by in `items` (a vocabulary's entries as they are after the change), for
 * those that go by one. An entry that goes by none keeps what its morphemes
 * hold.
 * @returns {Map<string, string>} entry id -> type
 */
export const entryTypeTargets = (items, rootIds) => {
  const tree = buildSenseTree(items);
  const out = new Map();
  const visit = (id) => {
    if (out.has(id) || !tree.byId.has(id)) return;
    const t = morphTypeOf(tree, id);
    if (isType(t)) out.set(id, t);
    for (const child of tree.childrenOf.get(id) || []) visit(child.id);
  };
  for (const id of rootIds || []) visit(id);
  return out;
};

/**
 * The entries a change to `before` (a vocabulary's entries) that made
 * `after` changes the type of: every entry whose own type or headword
 * changed, and everything below it.
 */
export const retypedRoots = (before, after) => {
  const was = new Map((before || []).map((it) => [it.id, it.metadata]));
  const roots = [];
  for (const it of after || []) {
    const old = was.get(it.id);
    if (!was.has(it.id)) continue;
    const m = it.metadata || {};
    if (
      (old?.morphType ?? null) !== (m.morphType ?? null) ||
      (old?.parent ?? null) !== (m.parent ?? null)
    ) {
      roots.push(it.id);
    }
  }
  return roots;
};

/** The ids of the projects `user` can write that use vocabulary `vocabId`. */
export const cacheProjectIds = async (client, user, vocabId) =>
  ((await client.projects.list()) || [])
    .filter((p) => canEditProject(p, user) && (p.vocabs || []).some((v) => v.id === vocabId))
    .map((p) => p.id);

/** The morphemes of project `projectId` linked to `itemIds`, with their cached type. */
const linkedMorphemesQuery = (projectId, itemIds) => ({
  scope: { projectIds: [projectId] },
  where: [
    ['link', '?l', { item: itemIds }],
    ['link-item', '?l', '?v'],
    ['link-token', '?l', '?t'],
    ['token', '?t', { layer: '?tl' }],
    ['token-layer', '?tl', {}],
    ['=', '?tl.config.plaid.role', 'morpheme'],
  ],
  return: { group: ['?t', '?v', '?t.metadata.morphType'], aggregates: [['count']] },
  limit: 100000,
});

/**
 * The cache writes `targets` (entry id -> type) call for in `projectIds`:
 * each morpheme linked to one of those entries whose cached type is another.
 * Reads only.
 * @returns {Promise<Array<{projectId: string, morphemeId: string, morphType: string}>>}
 */
export const planMorphTypeCaches = async (client, projectIds, targets) => {
  const ids = [...(targets?.keys() || [])];
  const out = [];
  if (!ids.length) return out;
  // Entries whose morphemes are more than one answer holds are asked for
  // in halves.
  const read = async (projectId, part) => {
    const res = await client.query(linkedMorphemesQuery(projectId, part));
    if (res?.truncated && part.length > 1) {
      const half = Math.ceil(part.length / 2);
      await read(projectId, part.slice(0, half));
      await read(projectId, part.slice(half));
      return;
    }
    if (res?.truncated) throw new Error('Too many morphemes are linked to one entry to read.');
    for (const [morphemeId, itemId, cached] of res?.results || []) {
      const morphType = targets.get(itemId);
      if (isType(morphType) && cached !== morphType) {
        out.push({ projectId, morphemeId, morphType });
      }
    }
  };
  for (const projectId of projectIds || []) {
    for (let i = 0; i < ids.length; i += CHUNK) await read(projectId, ids.slice(i, i + CHUNK));
  }
  return out;
};

/**
 * Write `plans` on `to` (a client, or a batch), one bulk update per project
 * and chunk: a bulk token update takes the documents of one project.
 */
export const sendMorphTypeCaches = async (to, plans) => {
  const byProject = new Map();
  for (const p of plans || []) {
    if (!byProject.has(p.projectId)) byProject.set(p.projectId, []);
    byProject.get(p.projectId).push(p);
  }
  for (const list of byProject.values()) {
    for (let i = 0; i < list.length; i += CHUNK) {
      await to.tokens.bulkUpdate(
        list.slice(i, i + CHUNK).map((p) => ({
          id: p.morphemeId,
          metadata: [{ op: 'set', path: ['morphType'], value: p.morphType }],
        })),
      );
    }
  }
};

/**
 * The cache writes for a change to the entries of vocabulary `vocabId` that
 * leaves them as `items`: the caches of `rootIds` and the entries below
 * them, in every project `user` can write. Reads only.
 */
export const planEntryChange = async (client, { user, vocabId, items, rootIds }) => {
  const targets = entryTypeTargets(items, rootIds);
  if (!targets.size) return [];
  return planMorphTypeCaches(client, await cacheProjectIds(client, user, vocabId), targets);
};

/**
 * A write that a lost answer sends again plans its cache writes once: a
 * second plan would read the first send's own writes and send other requests
 * under the same Idempotency-Keys. `plan` is called on the first send only.
 */
export const plannedOnce = (plan) => {
  let held = null;
  return () => (held ??= plan());
};

/**
 * What a merge of `loserIds` into `survivorId` calls for, read off `items`
 * (the vocabulary's entries before it) and `refPlans` (the whole metadata
 * each entry that referred to a loser ends up with, planMergeRefs): the
 * losers' morphemes take the survivor's type, as their links move to it, and
 * a sense moved under the survivor takes the type it goes by there.
 * @returns {Map<string, string>} entry id -> type
 */
export const mergeTargets = (items, refPlans, survivorId, loserIds) => {
  const byId = new Map((refPlans || []).map((p) => [p.id, p.metadata]));
  const after = (items || []).map((it) =>
    byId.has(it.id) ? { ...it, metadata: byId.get(it.id) } : it,
  );
  const losers = new Set(loserIds || []);
  const roots = [...retypedRoots(items, after).filter((id) => !losers.has(id)), survivorId];
  const targets = entryTypeTargets(
    after.filter((it) => !losers.has(it.id)),
    roots,
  );
  const t = targets.get(survivorId);
  if (t) for (const id of losers) targets.set(id, t);
  return targets;
};
