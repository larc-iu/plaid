// The entries a machine made and no person has looked at: Status `machine`
// ("Machine draft"), which an assistant job writes on every entry it creates.
// The Entries screen lists them on their own, and marks the ones it lists
// reviewed, or deletes them, in one operation each (SPEC 7.4). Each send plans
// in its turn from the entries as the server holds them then, so an entry a
// person has given another status since the list was drawn is left as they
// made it.

import {
  MACHINE_STATUS,
  buildSenseTree,
  morphTypeOf,
  planDeleteRefs,
} from '@/domain/vocabDictionary';
import { metadataUpdates } from '@/domain/metadataPatch';
import { planKeptTypes, queueKeptTypes } from '@/domain/keptMorphType';
import { CHUNK, chunk } from '@/domain/bulk';
import { dropPrecedent } from '@/domain/precedentCache';

const REVIEWED = 'reviewed';

/** Whether `item` is a machine draft of a vocabulary whose Status is `statusKey`. */
export const isMachineDraft = (item, statusKey) =>
  !!statusKey && item?.metadata?.[statusKey] === MACHINE_STATUS;

// The entries among `ids` that are machine drafts in `items`.
const stillDrafts = (items, ids, statusKey) => {
  const wanted = new Set(ids);
  return (items || []).filter((it) => wanted.has(it.id) && isMachineDraft(it, statusKey));
};

const readEntries = async (client, vocabularyId) =>
  (await client.vocabLayers.get(vocabularyId, true))?.items || [];

/**
 * Set the Status of the entries `ids` to reviewed, under one operation of kind
 * `review` (an accept of stored machine work). `sendPlanned` is the screen's
 * (useVocabEntries). Resolves `{ landed, error }`.
 */
export const sendMarkReviewed = ({ sendPlanned, client, vocabularyId, statusKey, ids }) =>
  sendPlanned(
    'Mark machine drafts reviewed',
    async (_setMessage, updates) => {
      for (const part of chunk(updates, CHUNK)) await client.vocabItems.bulkUpdate(part);
    },
    {
      plan: async () =>
        stillDrafts(await readEntries(client, vocabularyId), ids, statusKey).map((it) => ({
          id: it.id,
          metadata: [{ op: 'set', path: [statusKey], value: REVIEWED }],
        })),
      kind: 'review',
    },
  );

/**
 * The links to the entries `ids`, counted across the projects this person can
 * read, or null when they cannot be counted.
 */
export const countLinksTo = async (client, ids) => {
  try {
    const res = await client.query({
      where: [['link', '?l', { item: ids }]],
      return: { group: [], aggregates: [['count']] },
    });
    return res?.results?.[0]?.[0] ?? 0;
  } catch (err) {
    console.error('Link count failed:', err);
    return null;
  }
};

/**
 * What deleting the machine drafts among `ids` writes besides the delete, as
 * the single delete plans it (vocabDictionary's planDeleteRefs): the senses
 * under them become headwords, the fields that name them are cleared, and a
 * morpheme linked to one keeps the type it went by. Pure but for the read of
 * the links (planKeptTypes).
 */
const planDelete = async ({ client, user, items, fields, ids, statusKey }) => {
  const gone = stillDrafts(items, ids, statusKey).map((it) => it.id);
  const tree = buildSenseTree(items);
  const updates = metadataUpdates(
    planDeleteRefs(items, fields, gone),
    new Map(items.map((it) => [it.id, it.metadata])),
  );
  const kept = gone.length
    ? await planKeptTypes(client, user, { itemIds: gone }, (id) => morphTypeOf(tree, id))
    : [];
  return { gone, updates, kept };
};

/**
 * Delete the entries `ids` that are still machine drafts, with every link to
 * them, in one batch under one operation of kind `bulk-edit`. Deleting an
 * entry deletes its links and leaves the glosses. Resolves `{ landed, error }`.
 */
export const sendDeleteDrafts = ({
  sendPlanned,
  client,
  user,
  vocabularyId,
  fields,
  statusKey,
  ids,
}) =>
  sendPlanned(
    'Delete machine drafts',
    async (_setMessage, { gone, updates, kept }) => {
      if (!gone.length) return;
      try {
        await client.batched(async (b) => {
          for (const part of chunk(updates, CHUNK)) b.vocabItems.bulkUpdate(part);
          queueKeptTypes(b, kept);
          for (const part of chunk(gone, CHUNK)) b.vocabItems.bulkDelete(part);
        });
      } finally {
        // Their links go with them, in documents no editor has open.
        dropPrecedent();
      }
    },
    {
      plan: async () =>
        planDelete({
          client,
          user,
          items: await readEntries(client, vocabularyId),
          fields,
          ids,
          statusKey,
        }),
      kind: 'bulk-edit',
      ref: 'action:delete-machine-drafts',
    },
  );
