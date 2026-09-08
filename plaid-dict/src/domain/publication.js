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

export const PUBLISHED = 'published';

/** The key a vocabulary keeps its status under: the declared one, else the seed's. */
export const statusKeyOf = (fields) => statusFieldKey(fields) ?? STATUS_FIELD;
/** The same, from a vocab layer's whole config. */
export const statusKeyOfConfig = (config) => statusKeyOf(readVocabFields(config));

export const statusOf = (item, key = STATUS_FIELD) => {
  const v = item?.metadata?.[key];
  return typeof v === 'string' ? v : '';
};

export const isPublished = (item, key = STATUS_FIELD) => statusOf(item, key) === PUBLISHED;

/** How many of a vocabulary's entries are published, and how many there are. */
export const publicationCounts = (items, key = STATUS_FIELD) => {
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
 * The schema is read FRESH, never from the catalog: the catalog holds what the
 * server said when this tab opened, `setConfig` replaces a namespace key
 * wholesale, and the two apps are meant to be open at once. Writing from the
 * snapshot deleted whatever field or tagset plaid-igt had added since. Read
 * raw rather than through `readTagsets`, which rebuilds each tagset and would
 * drop anything it does not know on the way back out.
 */
export const publishAll = async (client, items, { vocabularyId, name, onProgress }) => {
  const igt = (await client.vocabLayers.get(vocabularyId))?.config?.[IGT_NAMESPACE] ?? {};
  const declared = statusFieldKey(igt.fields);
  const key = declared ?? STATUS_FIELD;
  const pending = (items || []).filter((it) => !isPublished(it, key));
  if (!pending.length) return 0;
  let done = 0;
  await client.withOperation(`Publish every entry in "${name || 'vocabulary'}"`, async () => {
    if (!declared) {
      const seed = statusFieldSeed({ fieldsConfig: igt.fields, tagsets: igt.tagsets });
      await client.vocabLayers.setConfig(vocabularyId, IGT_NAMESPACE, 'tagsets', seed.tagsets);
      await client.vocabLayers.setConfig(vocabularyId, IGT_NAMESPACE, 'fields', seed.fieldsConfig);
    }
    for (let i = 0; i < pending.length; i += BATCH_CHUNK) {
      const part = pending.slice(i, i + BATCH_CHUNK);
      await client.batched(async () => {
        for (const it of part) client.vocabItems.patchMetadata(it.id, { [key]: PUBLISHED });
      });
      done += part.length;
      onProgress?.({ done, total: pending.length });
    }
  });
  return done;
};
