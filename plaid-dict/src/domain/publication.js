// Publication status. plaid-igt gives a new vocabulary a `status`
// field held to a closed list (draft / reviewed / published) and never enforces
// it; the dictionary is where it decides anything.
//
// An entry is shown here if its own status is `published`. A headword that is
// not itself published still appears as the heading over its published senses,
// with its own gloss hidden: the tree's spine is structure, not content.

import { STATUS_FIELD, statusFieldSeed } from '@igt/domain/vocabDictionary.js';
import { readVocabFields, IGT_NAMESPACE } from '@igt/domain/igtConfig.js';
import { readTagsets } from '@igt/domain/tagsets.js';

export const PUBLISHED = 'published';

export const statusOf = (item) => {
  const v = item?.metadata?.[STATUS_FIELD];
  return typeof v === 'string' ? v : '';
};

export const isPublished = (item) => statusOf(item) === PUBLISHED;

/** How many of a vocabulary's entries are published, and how many there are. */
export const publicationCounts = (items) => {
  const list = items || [];
  return { published: list.filter(isPublished).length, total: list.length };
};

const BATCH_CHUNK = 200;

/**
 * Mark every entry published, in chunks, all under one operation. An imported
 * lexicon has no status on anything, so this is the only way past an empty
 * dictionary that does not involve a Bulk Edit field-replace in plaid-igt.
 * `onProgress({done, total})` fires after each chunk. Returns how many changed.
 *
 * A vocabulary made before plaid-igt seeded a Status field declares none, and
 * a value under a field the schema does not name is invisible in plaid-igt:
 * no control on the entry, nothing in Bulk Edit. So the field is declared here
 * first, in the same operation, on a vocabulary that lacks it.
 */
export const publishAll = async (client, items, { vocabulary, name, onProgress } = {}) => {
  const pending = (items || []).filter((it) => !isPublished(it));
  if (!pending.length) return 0;
  const fields = readVocabFields(vocabulary?.config);
  const undeclared = vocabulary && !(fields && STATUS_FIELD in fields);
  let done = 0;
  await client.withOperation(`Publish every entry in "${name || 'vocabulary'}"`, async () => {
    if (undeclared) {
      const seed = statusFieldSeed({
        fieldsConfig: fields ?? {},
        tagsets: readTagsets(vocabulary.config),
      });
      await client.vocabLayers.setConfig(vocabulary.id, IGT_NAMESPACE, 'tagsets', seed.tagsets);
      await client.vocabLayers.setConfig(vocabulary.id, IGT_NAMESPACE, 'fields', seed.fieldsConfig);
    }
    for (let i = 0; i < pending.length; i += BATCH_CHUNK) {
      const part = pending.slice(i, i + BATCH_CHUNK);
      await client.batched(async () => {
        for (const it of part)
          client.vocabItems.patchMetadata(it.id, { [STATUS_FIELD]: PUBLISHED });
      });
      done += part.length;
      onProgress?.({ done, total: pending.length });
    }
  });
  return done;
};
