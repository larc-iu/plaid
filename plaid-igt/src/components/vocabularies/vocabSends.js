// The field-value prune the vocabulary settings send through the entries'
// queue, planned once from one read of the entries (plaid-ui keyedSend).

import { keyedSend } from '@ui/domain/keyedSend.js';
import { CHUNK } from '@/domain/bulk';
import { fieldPruneWrites } from '@/domain/vocabFieldPrune';

/**
 * Bring every entry's value in `after.name` into what `after` can hold
 * (`fieldPruneWrites`), writing only what changes,
 * under the operation `Change "<label>"`.
 *
 * The entries are read once, and the writes planned from that read are what
 * every send of it sends (keyedSend's `plan`). `refused(err)` is the queue's.
 * Resolves to whether it landed.
 */
export const sendFieldPrune = ({ queue, client, vocabularyId, after, label, refused }) =>
  keyedSend(
    queue,
    client,
    `Change "${label}"`,
    async (_setMessage, updates) => {
      for (let i = 0; i < updates.length; i += CHUNK) {
        await client.vocabItems.bulkUpdate(updates.slice(i, i + CHUNK));
      }
    },
    {
      plan: async () => {
        const { items = [] } = await client.vocabLayers.get(vocabularyId, true);
        return fieldPruneWrites(items, after);
      },
      shown: false,
      refused,
    },
  );
