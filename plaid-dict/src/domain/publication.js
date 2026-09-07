// Publication status. plaid-igt gives a Lexicography Mode vocabulary a `status`
// field held to a closed list (draft / reviewed / published) and never enforces
// it; the dictionary is where it decides anything.
//
// An entry is shown here if its own status is `published`. A headword that is
// not itself published still appears as the heading over its published senses,
// with its own gloss hidden: the tree's spine is structure, not content.

import { STATUS_FIELD } from '@igt/domain/vocabDictionary.js';

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
 */
export const publishAll = async (client, items, { name, onProgress } = {}) => {
  const pending = (items || []).filter((it) => !isPublished(it));
  if (!pending.length) return 0;
  let done = 0;
  await client.withOperation(`Publish every entry in "${name || 'vocabulary'}"`, async () => {
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
