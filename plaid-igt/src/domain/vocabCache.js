// The entries of a vocabulary, kept between documents.
//
// Opening a document reads every entry of every vocabulary its project links,
// and a lexicon of 20,000 entries is a few megabytes and over a second of the
// open. The server moves a vocabulary's `timeModified` on every change to it or
// to any of its entries, so a copy read under one `timeModified` is still the
// vocabulary for as long as the vocabulary's own record (a few milliseconds to
// read) says the same time. Only then is the copy reused.
//
// The time is read BEFORE the entries. A change landing between the two reads
// leaves the copy filed under the older time, so the next open reads it again.
// Read the other way round, a copy older than its time would be reused until
// the vocabulary next changed.
//
// A vocabulary with no time (never stamped) is never reused. A read at a past
// time (`asOf`) is never kept: the history rail reads a moment once.
//
// What is handed out is a new object each time, since a document folds its own
// links into it, over the SAME entry list, frozen: every reader of an entry list
// replaces it rather than editing it (see cloneVocabs in IgtDocument.js), and
// the freeze makes one that did not fail loudly.

// client -> Map(vocabId -> { time, vocab })
const copies = new WeakMap();

const shelfOf = (client) => {
  let shelf = copies.get(client);
  if (!shelf) copies.set(client, (shelf = new Map()));
  return shelf;
};

const handOut = (vocab) => ({ ...vocab });

/**
 * Vocabulary `id` with its entries, as `client.vocabLayers.get(id, true)`
 * returns it, from the copy kept since the last read when the vocabulary has
 * not changed since. With `asOf`, the vocabulary as it was then, read afresh.
 */
export async function readVocabulary(client, id, asOf = null) {
  if (asOf) return client.vocabLayers.get(id, true, asOf);
  const shelf = shelfOf(client);
  const head = await client.vocabLayers.get(id);
  const time = head?.timeModified ?? null;
  const kept = shelf.get(id);
  if (time != null && kept && kept.time === time) return handOut(kept.vocab);
  const vocab = await client.vocabLayers.get(id, true);
  if (time == null || !vocab || !Array.isArray(vocab.items)) {
    shelf.delete(id);
    return vocab;
  }
  Object.freeze(vocab.items);
  shelf.set(id, { time, vocab });
  return handOut(vocab);
}
