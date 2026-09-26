// Publication status. plaid-igt seeds a new vocabulary with a `status`
// field held to a closed list (draft / reviewed / published), which its
// owner may drop, and never enforces it; the dictionary is where it decides
// anything.
//
// An entry is shown here if its own status is `published`. A headword that is
// not itself published still appears as the heading over its published senses,
// with its own gloss hidden: the tree's spine is structure, not content.
//
// The field is found by `statusFieldKey`, plaid-igt's own: a vocabulary that
// spells it "Status" has it under that key, and every read and write here
// goes to that key, never to a `status` beside it that no schema names.

import { STATUS_FIELD, statusFieldKey, statusFieldSeed } from '@igt/domain/vocabDictionary.js';
import { IGT_NAMESPACE, readVocabFields } from '@igt/domain/igtConfig.js';
import { metadataOps } from '@larc-iu/plaid-client';

export const PUBLISHED = 'published';

/** The key a vocabulary keeps its status under: the declared one, else the seed's. */
export const statusKeyOf = (fields) => statusFieldKey(fields) ?? STATUS_FIELD;
/** The same, from a vocab layer's whole config. */
export const statusKeyOfConfig = (config) => statusKeyOf(readVocabFields(config));

/**
 * The key every status read takes, from statusKeyOf. There is no default: a
 * read under `status` hid every entry of a vocabulary that spells it "Status".
 */
export const requireStatusKey = (key) => {
  if (typeof key !== 'string' || !key) throw new TypeError('A status read needs the status key');
  return key;
};

export const statusOf = (item, key) => {
  const v = item?.metadata?.[requireStatusKey(key)];
  return typeof v === 'string' ? v : '';
};

export const isPublished = (item, key) => statusOf(item, key) === PUBLISHED;

/** How many of a vocabulary's entries are published, and how many there are. */
export const publicationCounts = (items, key) => {
  requireStatusKey(key);
  const list = items || [];
  return { published: list.filter((it) => isPublished(it, key)).length, total: list.length };
};

const BATCH_CHUNK = 200;

/**
 * Mark every entry published, in chunks, all under one operation. An imported
 * lexicon has no status on anything, so this is the only way past an empty
 * dictionary that does not involve a Bulk Edit field-replace in plaid-igt.
 * `onProgress({done, total})` fires after each chunk. Returns how many changed.
 *
 * A vocabulary that declares no status field gets plaid-igt's own seed first,
 * in the same operation: a value under a field the schema does not name is
 * invisible in plaid-igt, no control on the entry, nothing in Bulk Edit. One
 * that declares it, in any case, is written under that key.
 *
 * The schema and the entries are read FRESH, never from what the page loaded:
 * the two apps are meant to be open at once. `setConfig` replaces a namespace
 * key wholesale, so writing from a stale schema deleted whatever field or
 * tagset plaid-igt had added since. Read raw rather than through
 * `readTagsets`, which rebuilds each tagset and would drop anything it does
 * not know on the way back out. And core refuses a whole batch when one of
 * its entries is gone, so a stale entry list failed every chunk it touched.
 * An entry deleted while this runs does the same to its chunk, which is then
 * sent again without the entries that no longer exist.
 */
export const publishAll = async (client, { vocabularyId, name, onProgress }) => {
  const layer = await client.vocabLayers.get(vocabularyId, true);
  const igt = layer?.config?.[IGT_NAMESPACE] ?? {};
  const declared = statusFieldKey(igt.fields);
  const key = declared ?? STATUS_FIELD;
  const pending = (layer?.items || []).filter((it) => !isPublished(it, key));
  if (!pending.length) return 0;
  // A metadata PATCH is a list of path ops. One top-level set leaves every
  // other key on the entry alone.
  const ops = metadataOps({ [key]: PUBLISHED });
  const send = (part) =>
    client.batched(async (b) => {
      for (const it of part) b.vocabItems.patchMetadata(it.id, ops);
    });
  let done = 0;
  let changed = 0;
  await client.withOperation(`Publish every entry in "${name || 'vocabulary'}"`, async () => {
    if (!declared) {
      const seed = statusFieldSeed({ fieldsConfig: igt.fields, tagsets: igt.tagsets });
      await client.vocabLayers.setConfig(vocabularyId, IGT_NAMESPACE, 'tagsets', seed.tagsets);
      await client.vocabLayers.setConfig(vocabularyId, IGT_NAMESPACE, 'fields', seed.fieldsConfig);
    }
    for (let i = 0; i < pending.length; i += BATCH_CHUNK) {
      let part = pending.slice(i, i + BATCH_CHUNK);
      try {
        await send(part);
      } catch (err) {
        if (err?.status !== 404) throw err;
        const { items: now = [] } = await client.vocabLayers.get(vocabularyId, true);
        const left = new Set(now.filter((it) => !isPublished(it, key)).map((it) => it.id));
        part = part.filter((it) => left.has(it.id));
        if (part.length) await send(part);
      }
      changed += part.length;
      done = Math.min(i + BATCH_CHUNK, pending.length);
      onProgress?.({ done, total: pending.length });
    }
  });
  return changed;
};
