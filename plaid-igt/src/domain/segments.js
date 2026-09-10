// Segments (time-alignment tokens) as the Media and Tokenize tabs reason
// about them, without React or the document: which ones carry a given text,
// and where sentence breaks would go to make one sentence per segment.

import { cpSlice } from '@larc-iu/plaid-client';

/** A segment's own stretch of the baseline, trimmed. */
export const segmentText = (body, token) => cpSlice(body ?? '', token.begin, token.end).trim();

/**
 * The segments whose text is `value` (trimmed on both sides), which for an
 * empty `value` is every segment with no text at all: the placeholders a
 * person makes and never types into.
 */
export const segmentsWithText = (tokens, body, value) => {
  const want = String(value ?? '').trim();
  return (tokens || []).filter((t) => segmentText(body, t) === want);
};

/**
 * Where the sentence layer would be split so that each segment starts a
 * sentence. A segment's start qualifies when it lies strictly inside a
 * sentence (a sentence already beginning there needs nothing) and not inside
 * a word, since a word belongs to one sentence and the server refuses a cut
 * through it. Splits only: a segment that spans several sentences leaves
 * them as they are.
 *
 * @returns {{positions: number[], insideWord: number}}
 *   positions in ascending order, plus how many starts were skipped for
 *   falling inside a word.
 */
export function splitPointsFromSegments({ sentences, words, alignments }) {
  const starts = new Set((sentences || []).map((s) => s.begin));
  const positions = new Set();
  let insideWord = 0;
  for (const seg of alignments || []) {
    const p = seg.begin;
    if (starts.has(p)) continue;
    const inSentence = (sentences || []).some((s) => s.begin < p && p < s.end);
    if (!inSentence) continue;
    if ((words || []).some((w) => w.begin < p && p < w.end)) {
      insideWord += 1;
      continue;
    }
    positions.add(p);
  }
  return { positions: [...positions].sort((a, b) => a - b), insideWord };
}
