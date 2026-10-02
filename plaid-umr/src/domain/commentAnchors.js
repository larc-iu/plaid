// What a comment in this app is attached to, said in words.
//
// A comment carries only `(entityType, entityId)`, which is enough where the
// badge sits and useless in a Comments tab, which would otherwise be a list of
// uuids. This walks the document once and builds `entityId -> descriptor` so a
// thread can say "Sentence 4".
//
// Comments here are SENTENCE and DOCUMENT level only: no per-node or per-edge
// threads. So the index is small, and a thread that names anything else is on a
// layer this app does not show: the Comments tab files it under "On other
// layers" while the document holds it, and as outdated once it is gone.
//
// What a thread SAYS about its anchor is plaid-ui's `anchorCaption`: it does
// not depend on what a document looks like, so the screens take it from
// there directly.

import { anchorExcerpt, documentAnchor, quoted } from '@ui/domain/commentAnchors';

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

  index.set(doc.id, documentAnchor(doc));

  // A sentence is anchored by its sentence TOKEN. The editor's `?sent=` deep
  // link names the sentence by its NUMBER, counting from one, so that is the
  // jump. A token id there found no block and the jump went nowhere.
  (doc.sentences || []).forEach((sentence, offset) => {
    if (!sentence?.tokenId) return;
    const number = sentence.index ?? offset + 1;
    const excerpt = anchorExcerpt(sentence.text);
    index.set(sentence.tokenId, {
      kind: 'sentence',
      label: `Sentence ${number}`,
      detail: quoted(excerpt),
      excerpt,
      sentenceIndex: number,
      sentenceId: sentence.tokenId,
      jumpId: String(number),
      order: [number],
    });
  });

  return index;
}
