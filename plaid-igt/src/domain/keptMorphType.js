// A morpheme linked to a lexicon entry goes by the entry's type and stores
// none of its own (R2). When the link goes and the morpheme stays (an Unlink,
// or the delete of the entry, which takes its links along), the same batch
// writes the entry's type onto the morpheme, so its affix marker survives in
// every export (ruling Q1, 2026-10-31). The morpheme is unlinked by that
// batch, so R2 holds.

import { ROLES } from '@larc-iu/plaid-client';
import { canEditProject } from '@ui/domain/permissions.js';
import { statusOf } from '@ui/lib/errors.js';
import { CHUNK } from './bulk.js';

/** The metadata ops that store `type` on a morpheme. */
const keptTypeOps = (type) => [{ op: 'set', path: ['morphType'], value: type }];

/**
 * What to say when a delete that writes kept types is refused because a
 * document they are in is locked (423: a service run, or someone's write,
 * holds it). The whole delete waits: a held document is not skipped, or its
 * morphemes would lose their type. Null for any other refusal.
 */
export const busyLinkedDocument = (error) =>
  statusOf(error) === 423 ? 'A document linked to it is in use. Try again when it is free.' : null;

// The hard cap of a query's rows (plaid-core).
const QUERY_LIMIT = 100000;

/**
 * The morphemes that keep a type when links go: every morpheme linked to an
 * entry in `itemIds` (the entries a delete takes, with their links), or with
 * `vocabId` and `projectId` every one of that project linked into that
 * vocabulary (the project dropping it), that this person can see and is in
 * a project they can write. Each keeps the type `typeOf(itemId)` says its
 * entry goes by (its own, else its headword's). An entry that goes by none
 * gives nothing. Answers bulk-update rows `{ id, metadata }` grouped by
 * project, `[{ projectId, rows }]` (a bulk token update stays in one project).
 *
 * A link in a project this person cannot read or write is deleted all the
 * same and its morpheme stays untyped: nothing here can write it.
 */
export async function planKeptTypes(client, user, { itemIds, vocabId, projectId }, typeOf) {
  let where;
  if (vocabId) {
    where = [
      ['vocab', '?i', { layer: vocabId }],
      ['link-item', '?l', '?i'],
    ];
  } else {
    const typed = (itemIds || []).filter((id) => typeOf(id));
    if (!typed.length) return [];
    where = [['link', '?l', { item: typed }]];
  }
  const res = await client.query({
    where: [
      ...where,
      ['link-token', '?l', '?t'],
      ['token', '?t', { layer: '?tl' }],
      ['token-layer', '?tl', {}],
    ],
    return: {
      group: ['?l.item', '?t', '?tl', '?tl.config.plaid.role'],
      aggregates: [['count']],
    },
    limit: QUERY_LIMIT,
    ...(projectId ? { scope: { projectIds: [projectId] } } : {}),
  });
  const found = (res?.results || []).filter(
    ([item, , , role]) => role === ROLES.MORPHEME && typeOf(String(item)),
  );
  if (!found.length) return [];
  // Which project each morpheme layer is in, and whether this person may
  // write there.
  const projectOfLayer = new Map();
  const writable = new Map();
  for (const layerId of new Set(found.map(([, , tl]) => String(tl)))) {
    const layer = await client.tokenLayers.get(layerId);
    const pid = layer?.project ?? null;
    projectOfLayer.set(layerId, pid);
    if (pid && !writable.has(pid)) {
      const project = await client.projects.get(pid).catch(() => null);
      writable.set(pid, canEditProject(project, user));
    }
  }
  const byProject = new Map();
  const seen = new Set();
  for (const [item, token, tl] of found) {
    const pid = projectOfLayer.get(String(tl));
    if (!pid || !writable.get(pid) || seen.has(token)) continue;
    seen.add(token);
    if (!byProject.has(pid)) byProject.set(pid, []);
    byProject.get(pid).push({ id: String(token), metadata: keptTypeOps(typeOf(String(item))) });
  }
  return [...byProject].map(([pid, rows]) => ({ projectId: pid, rows }));
}

/** Queue `planKeptTypes`'s rows on batch `b`, one bulk update per chunk. */
export function queueKeptTypes(b, plan) {
  for (const { rows } of plan || []) {
    for (let i = 0; i < rows.length; i += CHUNK) b.tokens.bulkUpdate(rows.slice(i, i + CHUNK));
  }
}
