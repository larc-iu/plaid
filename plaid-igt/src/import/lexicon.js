// The lexicon half of an importer that is not about its format.
//
// Three importers write vocabulary entries (FLEx, CLDF, the archive). Each
// plans its own entries, with its own source key stamped on what it makes so a
// resume can ask the data which entries are already there. Under that
// planning they do the same things, which live here: find the entries an
// earlier run made, create the rest in chunks, put a sense that has no parent
// yet under its entry, and merge new fields into the vocabulary's schema.

import { createdIds } from '@larc-iu/plaid-client';
import { CHUNK, withMintedIds } from '../domain/bulk.js';
import { IGT_NAMESPACE, readVocabFields } from '../domain/igtConfig.js';
import { writeVocabConfig } from './resume.js';

/**
 * The key the archive import stamps on an entry it made, the archive item id.
 * Bookkeeping, not the project's data: the archive export strips it.
 */
export const NATIVE_ITEM_KEY = 'nativeImportId';

/** Map<source key value, item id> over the items stamped with `sourceKey`. */
export function itemsBySourceKey(items, sourceKey) {
  const byKey = new Map();
  for (const item of items || []) {
    const key = item.metadata?.[sourceKey];
    if (key) byKey.set(key, item.id);
  }
  return byKey;
}

/**
 * Creates each of `entries` (`{key, form, metadata}`, metadata as it is to be
 * stored) whose key `known` does not hold yet, and records the new item ids in
 * `known` under their keys. Answers the set of ids it made.
 *
 * bulkCreate, not a batch of per-item creates: the bulk endpoint is one
 * request, one operation row and one pass over the table, where a batch of N
 * creates re-dispatches the whole REST stack N times and writes N operation
 * rows, all inside the same held write lock. `ids` come back in input order.
 *
 * `onChunk(chunk, ids)` runs after each chunk is recorded, `onProgress(done,
 * total)` after that.
 */
export async function createEntriesOnce({
  client,
  vocabId,
  entries,
  known,
  check = () => {},
  onChunk,
  onProgress,
}) {
  const pending = entries.filter((e) => !known.has(e.key));
  const created = new Set();
  let done = 0;
  for (let i = 0; i < pending.length; i += CHUNK) {
    check();
    const chunk = pending.slice(i, i + CHUNK);
    const ids = createdIds(
      await client.vocabItems.bulkCreate(
        withMintedIds(
          chunk.map((e) => ({ vocabLayerId: vocabId, form: e.form, metadata: e.metadata })),
        ),
      ),
    );
    chunk.forEach((e, j) => {
      if (ids[j]) {
        known.set(e.key, ids[j]);
        created.add(ids[j]);
      }
    });
    if (onChunk) await onChunk(chunk, ids);
    done += chunk.length;
    onProgress?.(done, pending.length);
  }
  return created;
}

/**
 * Puts each sense of `places` (`{id, parent, senseOrder}`, as item ids) under
 * its parent, once every item has an id.
 *
 * Only a sense that has no parent YET is placed, rather than one this run
 * created. An entry created by a run that was cancelled or lost part way
 * through has none either, and asking "did this run make it" left such an
 * entry flat forever: the resume neither recreates it nor places it. A sense
 * someone has since moved under another entry keeps that place. `only` narrows
 * it further to the items in that set.
 *
 * One bulk update per chunk, not a batch of one patch per sense: a batch
 * re-dispatches the whole REST stack per op inside the held write lock.
 */
export async function placeSenses({ client, existing, places, only = null, check = () => {} }) {
  const placedAlready = new Set(
    (existing.items || []).filter((it) => it.metadata?.parent).map((it) => it.id),
  );
  const fresh = places.filter((p) => !placedAlready.has(p.id) && (!only || only.has(p.id)));
  for (let i = 0; i < fresh.length; i += CHUNK) {
    check();
    await client.vocabItems.bulkUpdate(
      fresh.slice(i, i + CHUNK).map((p) => ({
        id: p.id,
        metadata: [
          { op: 'set', path: ['parent'], value: p.parent },
          { op: 'set', path: ['senseOrder'], value: p.senseOrder },
        ],
      })),
    );
  }
}

/**
 * The vocabulary's field schema with `keys` merged in, written where it
 * differs (so a resume writes nothing the first run already did). MERGED
 * into what the vocabulary already declares, never written over it: project
 * setup puts fields there when it makes the vocabulary, and a vocabulary being
 * added to keeps its own fields, order and inline flags. A key new to it is
 * appended as `declare(key)` makes it. One it has already is kept, or given
 * `redeclare(key, field)` when that is passed.
 */
export async function mergeFieldSchema({ client, vocabId, existing, keys, declare, redeclare }) {
  const fieldsConfig = { ...(readVocabFields(existing.config) ?? {}) };
  for (const name of keys) {
    if (name in fieldsConfig) {
      if (redeclare) fieldsConfig[name] = redeclare(name, fieldsConfig[name]);
      continue;
    }
    fieldsConfig[name] = declare(name);
  }
  await writeVocabConfig(existing, IGT_NAMESPACE, 'fields', fieldsConfig, () =>
    client.vocabLayers.setConfig(vocabId, IGT_NAMESPACE, 'fields', fieldsConfig),
  );
}
