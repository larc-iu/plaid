// What a comment in this app is attached to, said in words.
//
// A comment carries only `(entityType, entityId)`, which is enough where the
// badge sits and useless in a Comments tab, which would otherwise be a list of
// uuids. This walks the document once and builds `entityId -> descriptor` so a
// thread can say "Sentence 4".
//
// Comments here are SENTENCE and DOCUMENT level only: no per-node or per-edge
// threads. So the index is small, and a thread that names anything else came
// from another app on the same substrate and describes as outdated, which is
// honest: this app cannot show you an IGT gloss.
//
// `anchorCaption` lives in plaid-ui: it does not depend on what a document
// looks like. Re-exported so this file is the one place the app asks about an
// anchor.

export { anchorCaption } from '@ui/domain/commentAnchors';

const QUOTE_LIMIT = 60;

const quote = (text) => {
  const clean = String(text || '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!clean) return '';
  return clean.length > QUOTE_LIMIT ? `“${clean.slice(0, QUOTE_LIMIT - 1)}…”` : `“${clean}”`;
};

/**
 * The anchor index for one document: its own thread, and one per sentence.
 *
 * A sentence is labelled by its position, which is what it is called
 * everywhere else in this app, and quoted so a reader can find it by what it
 * says rather than by counting.
 *
 * `order` is the position for text-order sorting: the document first, then each
 * sentence in turn.
 */
export function buildAnchorIndex(doc) {
  const index = new Map();
  if (!doc) return index;

  index.set(doc.id, {
    kind: 'document',
    label: doc.name || 'This document',
    detail: '',
    sentenceIndex: null,
    sentenceId: null,
    jumpId: null,
    order: [-1],
  });

  // A sentence is anchored by its sentence TOKEN, which is also what the
  // editor's `?sent=` deep link names. `index` is the sentence's number,
  // counting from one.
  (doc.sentences || []).forEach((sentence, offset) => {
    if (!sentence?.tokenId) return;
    const number = sentence.index ?? offset + 1;
    index.set(sentence.tokenId, {
      kind: 'sentence',
      label: `Sentence ${number}`,
      detail: quote(sentence.text),
      sentenceIndex: number,
      sentenceId: sentence.tokenId,
      jumpId: sentence.tokenId,
      order: [number],
    });
  });

  return index;
}
