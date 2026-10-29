// The lexicon half of an importer that is not about its format.
//
// Three importers write vocabulary entries (FLEx, CLDF, the archive). Each
// plans its own entries, with its own source key stamped on what it makes, so
// an import into a lexicon that already holds an entry finds it. Under that
// planning they do the same things, which live here: find the entries already
// there, create the rest in chunks, put a sense that has no parent yet under
// its entry, and merge new fields into the vocabulary's schema.

import { createdIds } from '@larc-iu/plaid-client';
import { statusOf } from '@ui/lib/errors.js';
import { sameConfig } from '@ui/domain/configCells.js';
import { CHUNK, withMintedIds } from '../domain/bulk.js';
import { IGT_NAMESPACE, readVocabFields } from '../domain/igtConfig.js';

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
 * Run `write`, the write of `value` to key `key` of namespace `ns` in
 * vocabulary `vocab`'s config (`vocab` as read, with `id`, `name` and
 * `config`; `value` undefined for a removal), only when the stored value
 * differs. Only a maintainer of the vocabulary may change its config, and an
 * import into a lexicon someone else keeps may not be one: it then writes
 * nothing that is already there, and a write still needed and refused says
 * who can make it. The caller makes the call itself, so the config keys each
 * importer writes stay readable at its call site. True when it wrote.
 */
export async function writeVocabConfig(vocab, ns, key, value, write) {
  const stored = vocab?.config?.[ns]?.[key];
  if (value === undefined ? stored === undefined : sameConfig(stored, value)) return false;
  try {
    await write();
  } catch (err) {
    if (statusOf(err) !== 403) throw err;
    throw new Error(
      `Only a maintainer of the vocabulary “${vocab?.name ?? vocab?.id}” can import into it.`,
      { cause: err },
    );
  }
  return true;
}

/**
 * Puts each sense of `places` (`{id, parent, senseOrder}`, as item ids) under
 * its parent, once every item has an id.
 *
 * Only a sense that has no parent yet is placed: a sense someone has moved
 * under another entry keeps that place. `only` narrows it further to the
 * items in that set.
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
 * differs. MERGED
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
