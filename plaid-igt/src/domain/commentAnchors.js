// What a comment is attached to, said in words.
//
// A comment carries only `(entityType, entityId)`. That is enough for the
// grid, where the badge sits on the thing it is about, but useless in the
// Comments tab, which would otherwise be a list of uuids. This walks the
// document once and builds `entityId -> descriptor` so every thread can say
// "Gloss of ktab, sentence 4".
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
 * Build `entityId -> { kind, label, detail, sentenceIndex, sentenceId }` for
 * every commentable entity in the document.
 *
 * `kind` is one of document | text | sentence | word | morpheme | annotation.
 * `label` is the short heading; `detail` is the sentence context, or ''.
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
    });
  }

  const sentences = doc.sentences || [];
  sentences.forEach((sentence, sIdx) => {
    const where = `sentence ${sIdx + 1}`;
    const at = { sentenceIndex: sIdx, sentenceId: sentence.id };

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
 * Describe one anchor, falling back to something honest when the entity is
 * gone. A comment outliving its anchor should not happen — the server sweeps
 * them — but a stale client between a delete and a reload can see one, and
 * "Deleted" beats a raw uuid.
 */
export function describeAnchor(index, entityType, entityId) {
  return (
    index.get(entityId) ?? {
      kind: 'unknown',
      label: entityType === 'document' ? 'This document' : 'Deleted',
      detail: '',
      sentenceIndex: null,
      sentenceId: null,
    }
  );
}
