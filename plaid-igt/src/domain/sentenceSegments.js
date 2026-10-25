// Which alignment segment a sentence falls in, and so its timing and speaker,
// for the exporters. Two rules, as the formats use them: the covering rule
// (phraseTimingFor, phraseSpeakerFor: the .flextext, CLDF, LaTeX book and plain
// text exports) and the contained-first rule (containedAlignments,
// sentenceSpeaker, sentenceTiming: the .eaf export).

// The single alignment token an analysis phrase inherits from: an exact extent
// match, else a unique token whose extent contains the sentence. Null when
// there's no unique match (partial overlap, ambiguity) — we never invent
// alignment. Shared by the timing and speaker projections so both stay
// truthful in exactly the same cases.
// A sentence's extent less the whitespace at its edges (the separator a
// transcript row's sentence holds after the row's text), read from its pieces.
// A sentence with no words is one piece, trimmed at both ends. Whitespace is
// the head rule's: a next-line character (U+0085) counts, as in core.
const isSpace = (c) => /\s/u.test(c) || c === '\u0085';
const leadingSpace = (cps) => {
  let n = 0;
  while (n < cps.length && isSpace(cps[n])) n += 1;
  return n;
};
function textExtent(sentence) {
  const pieces = sentence.pieces || [];
  let { begin, end } = sentence;
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  if (first?.type === 'gap' && typeof first.content === 'string') {
    begin += leadingSpace([...first.content]);
  }
  if (last?.type === 'gap' && typeof last.content === 'string') {
    end -= leadingSpace([...last.content].reverse());
  }
  return begin < end ? { begin, end } : { begin: sentence.begin, end: sentence.end };
}

function coveringAlignment(sentence, tokens) {
  const { begin, end } = textExtent(sentence);
  const exact = tokens.filter(
    (t) =>
      (t.begin === sentence.begin && t.end === sentence.end) ||
      (t.begin === begin && t.end === end),
  );
  const candidates = exact.length ? exact : tokens.filter((t) => t.begin <= begin && t.end >= end);
  return candidates.length === 1 ? candidates[0] : null;
}

/** {beginMs, endMs} for a sentence, or null when no unique truthful match. */
export function phraseTimingFor(sentence, validTokens) {
  const t = coveringAlignment(sentence, validTokens);
  if (!t) return null;
  const { timeBegin, timeEnd } = t.metadata;
  return { beginMs: Math.round(timeBegin * 1000), endMs: Math.round(timeEnd * 1000) };
}

// Speaker (diarization) for a sentence, or null. Same strict unique-match rule
// as timing, but resolved over ALL alignment tokens (a speaker is independent
// of whether the segment carries valid times). FLEx has no per-phrase speaker
// in its glossing model proper — `speaker` is an ELAN-interop phrase attribute
// alongside the time offsets — so a phrase that straddles a speaker change just
// gets no speaker rather than a wrong one.
export function phraseSpeakerFor(sentence, tokens) {
  const s = coveringAlignment(sentence, tokens)?.metadata?.speaker;
  return typeof s === 'string' && s.trim() !== '' ? s.trim() : null;
}

/**
 * The alignment tokens lying WHOLLY inside a sentence, in text order. A token
 * straddling the boundary matches no sentence by design (see the header note).
 */
export function containedAlignments(sentence, tokens) {
  return (tokens || [])
    .filter((t) => t.begin >= sentence.begin && t.end <= sentence.end)
    .sort((a, b) => a.begin - b.begin);
}

/**
 * The speaker a sentence's tiers are filed under, or null. Resolved the same way
 * as its timing, so the two never disagree: the unique speaker among the
 * alignment tokens INSIDE the sentence, falling back to the strict covering-token
 * rule the .flextext export uses when the sentence contains none (an alignment
 * wider than the sentence). Contained segments that disagree yield no speaker
 * rather than an arbitrary one.
 */
export function sentenceSpeaker(sentence, tokens) {
  const inside = containedAlignments(sentence, tokens);
  if (inside.length) {
    const named = new Set(
      inside
        .map((t) => t.metadata?.speaker)
        .filter((sp) => typeof sp === 'string' && sp.trim() !== '')
        .map((sp) => sp.trim()),
    );
    return named.size === 1 ? [...named][0] : null;
  }
  return phraseSpeakerFor(sentence, tokens);
}

/**
 * {beginMs, endMs} for a sentence: the span of the alignment tokens inside it,
 * or null when it contains none. Milliseconds, since ELAN assumes them.
 */
export function sentenceTiming(sentence, validTokens) {
  const inside = containedAlignments(sentence, validTokens);
  if (!inside.length) return null;
  return {
    beginMs: Math.round(Math.min(...inside.map((t) => t.metadata.timeBegin)) * 1000),
    endMs: Math.round(Math.max(...inside.map((t) => t.metadata.timeEnd)) * 1000),
  };
}
