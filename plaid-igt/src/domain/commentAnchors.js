// What a comment is attached to, said in words.
//
// A comment carries only `(entityType, entityId)`. That is enough for the
// grid, where the badge sits on the thing it is about, but useless in the
// Comments tab, which would otherwise be a list of uuids. This walks the
// document once and builds `entityId -> descriptor` so every thread can say
// "Gloss of ktab, sentence 4".
//
// The same words are the CAPTION a comment is posted with (`anchorCaption`),
// because a comment outlives its anchor: when the word it was about is
// merged, re-segmented, or retyped away, the comment stays and the caption is
// what it has left to show. `describeAnchor` marks such a comment outdated.
//
// Framework-agnostic, like everything else under domain/.

// Longest form we will inline into a label before trimming. Long enough for a
// real word or a short translation, short enough that a thread heading stays
// one line.
const MAX_QUOTE = 32;

const quote = (s) => {
  const t = String(s ?? '').trim();
  if (!t) return '';
  return t.length > MAX_QUOTE ? `${t.slice(0, MAX_QUOTE - 1)}…` : t;
};

/**
 * Build `entityId -> { kind, label, detail, sentenceIndex, sentenceId, jumpId }`
 * for every commentable entity in the document.
 *
 * `kind` is one of document | text | sentence | word | morpheme | annotation.
 * `label` is the short heading; `detail` is the sentence context, or ''.
 * `jumpId` is what a "show me" link navigates to (the sentence), or null.
 * `order` is the anchor's place in the text as an array compared entry by
 * entry: sentence, word, morpheme, then the thing itself before its values.
 *
 * Annotations (spans) are indexed at all three scopes, so a comment on a
 * sentence translation and a comment on a morpheme gloss both resolve.
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

  // The baseline text. Commentable server-side; nothing in the UI offers it
  // yet, but a thread created by another client must still be describable.
  const textId = doc.document?.text?.id;
  if (textId) {
    index.set(textId, {
      kind: 'text',
      label: 'Baseline text',
      detail: '',
      sentenceIndex: null,
      sentenceId: null,
      jumpId: null,
      order: [-1, 1],
    });
  }

  const sentences = doc.sentences || [];
  sentences.forEach((sentence, sIdx) => {
    const where = `sentence ${sIdx + 1}`;
    const at = { sentenceIndex: sIdx, sentenceId: sentence.id, jumpId: sentence.id };

    index.set(sentence.id, {
      kind: 'sentence',
      label: `Sentence ${sIdx + 1}`,
      detail: quote(sentenceText(sentence)),
      ...at,
      order: [sIdx, -1, -1, 0],
    });

    for (const [field, span] of Object.entries(sentence.annotations || {})) {
      if (span?.id) {
        index.set(span.id, {
          kind: 'annotation',
          label: `${field} of sentence ${sIdx + 1}`,
          detail: quote(span.value),
          ...at,
          order: [sIdx, -1, -1, 1],
        });
      }
    }

    (sentence.tokens || []).forEach((token, wIdx) => {
      index.set(token.id, {
        kind: 'word',
        label: quote(token.content) || 'Word',
        detail: where,
        ...at,
        order: [sIdx, wIdx, -1, 0],
      });

      for (const [field, span] of Object.entries(token.annotations || {})) {
        if (span?.id) {
          index.set(span.id, {
            kind: 'annotation',
            label: `${field} of ${quote(token.content)}`,
            detail: where,
            ...at,
            order: [sIdx, wIdx, -1, 1],
          });
        }
      }

      (token.morphemes || []).forEach((morph, mIdx) => {
        const form = quote(morph.metadata?.form || morph.content);
        index.set(morph.id, {
          kind: 'morpheme',
          label: form || 'Morpheme',
          detail: `in ${quote(token.content)}, ${where}`,
          ...at,
          order: [sIdx, wIdx, mIdx, 0],
        });

        for (const [field, span] of Object.entries(morph.annotations || {})) {
          if (span?.id) {
            index.set(span.id, {
              kind: 'annotation',
              label: `${field} of ${form}`,
              detail: `in ${quote(token.content)}, ${where}`,
              ...at,
              order: [sIdx, wIdx, mIdx, 1],
            });
          }
        }
      });
    });
  });

  return index;
}

// The sentence's own text, for context under its heading. Built from the
// pieces the grid already computed rather than re-slicing the body.
function sentenceText(sentence) {
  const pieces = sentence.pieces || [];
  if (pieces.length) return pieces.map((p) => p.content ?? '').join('');
  return (sentence.tokens || []).map((t) => t.content).join(' ');
}

/**
 * Build `entryId -> descriptor` for a vocabulary's entries, the counterpart of
 * `buildAnchorIndex` for the vocabulary page. `jumpId` is the entry, since
 * "show me" there opens the entry.
 */
export function buildEntryAnchorIndex(items, { glossField = 'gloss' } = {}) {
  const index = new Map();
  for (const item of items || []) {
    if (!item?.id) continue;
    index.set(item.id, {
      kind: 'entry',
      label: quote(item.form) || 'Entry',
      detail: quote(item.metadata?.[glossField]),
      sentenceIndex: null,
      sentenceId: null,
      jumpId: item.id,
    });
  }
  return index;
}

/**
 * `describeAnchor` and `anchorCaption` moved to plaid-ui: they turn a
 * descriptor into words and decide whether the thing it named is still there,
 * and neither depends on what an app's document looks like. The two builders
 * above do, which is why they stayed. Re-exported so this file is still the one
 * place this app asks about an anchor.
 */
export { describeAnchor, anchorCaption } from '@ui/domain/commentAnchors';
