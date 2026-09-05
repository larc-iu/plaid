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
    });

    for (const [field, span] of Object.entries(sentence.annotations || {})) {
      if (span?.id) {
        index.set(span.id, {
          kind: 'annotation',
          label: `${field} of sentence ${sIdx + 1}`,
          detail: quote(span.value),
          ...at,
        });
      }
    }

    for (const token of sentence.tokens || []) {
      index.set(token.id, {
        kind: 'word',
        label: quote(token.content) || 'Word',
        detail: where,
        ...at,
      });

      for (const [field, span] of Object.entries(token.annotations || {})) {
        if (span?.id) {
          index.set(span.id, {
            kind: 'annotation',
            label: `${field} of ${quote(token.content)}`,
            detail: where,
            ...at,
          });
        }
      }

      for (const morph of token.morphemes || []) {
        const form = quote(morph.metadata?.form || morph.content);
        index.set(morph.id, {
          kind: 'morpheme',
          label: form || 'Morpheme',
          detail: `in ${quote(token.content)}, ${where}`,
          ...at,
        });

        for (const [field, span] of Object.entries(morph.annotations || {})) {
          if (span?.id) {
            index.set(span.id, {
              kind: 'annotation',
              label: `${field} of ${form}`,
              detail: `in ${quote(token.content)}, ${where}`,
              ...at,
            });
          }
        }
      }
    }
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

// The heading for an anchor that no longer exists, by what it was.
const GONE = {
  document: 'This document',
  text: 'Baseline text',
  token: 'Deleted word',
  span: 'Deleted annotation',
  relation: 'Deleted relation',
  'vocab-item': 'Deleted entry',
};

/**
 * Describe one anchor. When the entity is gone the descriptor is OUTDATED:
 * the comment outlived what it was about (a merge, a re-segmentation, a typo
 * fix that recreated the word, a deleted entry), and `anchorLabel`, the
 * caption it was posted with, is the honest heading. Nothing is offered to
 * jump to.
 */
export function describeAnchor(index, entityType, entityId, anchorLabel = null) {
  const found = index.get(entityId);
  if (found) return found;
  const caption = String(anchorLabel ?? '').trim();
  return {
    kind: 'outdated',
    outdated: true,
    label: caption || GONE[entityType] || 'Deleted',
    detail: '',
    sentenceIndex: null,
    sentenceId: null,
    jumpId: null,
  };
}

/**
 * The caption to post a comment with: the descriptor's words, so an outdated
 * comment later reads the way its thread heading did. A sentence, the
 * document, and the text are their own label; anything inside a sentence
 * says where it sat.
 */
export function anchorCaption(descriptor) {
  if (!descriptor) return null;
  const { kind, label, detail } = descriptor;
  const place = ['word', 'morpheme', 'annotation', 'entry'].includes(kind) && detail;
  return place ? `${label}, ${detail}` : label || null;
}
