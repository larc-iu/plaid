// How the vocabulary screens send a write through their queues: under an
// operation of its own and its Idempotency-Key seed (the client's `keySeed`),
// fixed when the write is queued, so a send whose answer was lost goes again
// under the same keys until it is answered (WriteQueue `resendWhenBack`), and
// what landed the first time is answered from what it stored.

import { uuidv7 } from '@larc-iu/plaid-client';
import { isUnknownOutcome, isUnreachable } from '@ui/lib/errors.js';
import { CHUNK } from '@/domain/bulk';
import { fieldPruneWrites } from '@/domain/vocabFieldPrune';

/**
 * Queue `write` on `queue` under the operation `label`. `opts` are the
 * queue's (`refused`, `resync`, `shown`). Resolves to whether it landed.
 */
export const sendKeyed = (queue, client, label, write, opts = {}) => {
  const once = { groupId: uuidv7(), keys: client.keySeed?.() };
  return queue.push(() => client.withOperation(label, write, once), {
    ...opts,
    resendWhenBack: isUnknownOutcome,
  });
};

/**
 * Bring every entry's value in `after.name` into what `after` can hold
 * (`fieldPruneWrites`), writing only what changes,
 * under the operation `Change "<label>"`.
 *
 * The entries are read once, and the writes planned from that read are what
 * every send of it sends: a send after a lost answer that read again would
 * see its own first writes and plan other requests under the same keys. A
 * read the network failed is tried again too. `refused(err)` is the queue's.
 * Resolves to whether it landed.
 */
export const sendFieldPrune = ({ queue, client, vocabularyId, after, label, refused }) => {
  let updates = null;
  const once = { groupId: uuidv7(), keys: client.keySeed?.() };
  return queue.push(
    async () => {
      if (!updates) {
        const { items = [] } = await client.vocabLayers.get(vocabularyId, true);
        updates = fieldPruneWrites(items, after);
      }
      if (!updates.length) return;
      await client.withOperation(
        `Change "${label}"`,
        async () => {
          for (let i = 0; i < updates.length; i += CHUNK) {
            await client.vocabItems.bulkUpdate(updates.slice(i, i + CHUNK));
          }
        },
        once,
      );
    },
    {
      shown: false,
      refused,
      resendWhenBack: (err) => isUnknownOutcome(err) || (!updates && isUnreachable(err)),
    },
  );
};
