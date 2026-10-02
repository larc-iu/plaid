// What a comment in this app is attached to, said in words.
//
// A comment carries only `(entityType, entityId)`, which is enough where the
// badge sits and useless in a Comments tab, which would otherwise be a list of
// uuids. This walks the document once and builds `entityId -> descriptor` so a
// thread can say "Sentence 4".
//
// Comments here are SENTENCE and DOCUMENT level only, by ruling: no per-word or
// per-annotation threads. So the index is small, and a thread that names
// anything else is on a layer this app does not show: the Comments tab files it
// under "On other layers" while the document holds it, and as outdated once it
// is gone.
//
// `anchorCaption` lives in plaid-ui: it does not depend on what a document
// looks like. Re-exported so this file is the one place the app asks about an
// anchor.

import { anchorExcerpt, documentAnchor, quoted } from '@ui/domain/commentAnchors';

export { anchorCaption } from '@ui/domain/commentAnchors';

/**
 * The anchor index for one document: its own thread, and one per sentence.
 *
 * A sentence is labelled by its `sent_id` when it has one, since that is the
 * name the corpus already gave it and the one that will still mean something in
 * an exported file. Its position is the fallback and always the sub-heading, so
 * a reader can find it either way.
 *
 * `order` is the position for text-order sorting: the document first, then each
 * sentence in turn.
 */
export function buildAnchorIndex(doc) {
  const index = new Map();
  if (!doc) return index;

  index.set(doc.id, documentAnchor(doc));

  (doc.sentences || []).forEach((sentence, index_) => {
    const sentId = sentence.sentenceToken?.metadata?.sent_id;
    const position = `Sentence ${index_ + 1}`;
    const excerpt = anchorExcerpt(sentence.text);
    index.set(sentence.id, {
      kind: 'sentence',
      label: sentId ? String(sentId) : position,
      detail: sentId ? `${position} · ${quoted(excerpt)}` : quoted(excerpt),
      excerpt,
      sentenceIndex: index_,
      sentenceId: sentence.id,
      jumpId: sentence.id,
      order: [index_],
    });
  });

  return index;
}
