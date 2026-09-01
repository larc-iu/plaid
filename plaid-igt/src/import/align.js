// Matching a known word form against a position in a baseline string.
//
// Shared by the importers that are handed an ORDERED list of word forms with
// no character offsets and have to re-derive them: FLEx segments
// (flex/buildDocuments.js) and CLDF's Analyzed_Word (cldf/buildDocuments.js).
// Matching is case-folded because a stored form routinely differs in case from
// the surface it came from (the text says "За", the analysis stores "за").

/**
 * A reusable UTF-16 index → code-point index converter for one string.
 *
 * The client's `utf16ToCp` is `[...s.slice(0, u)].length`, which allocates and
 * spreads the whole prefix on every call. That is fine once and quadratic when
 * called per token: on a 370KB document body it took ~19s of a 24s import.
 * Building the mapping once makes each lookup O(1).
 *
 * Most bodies have no astral characters at all, in which case the two indexes
 * coincide and no table is needed.
 *
 * An index inside a surrogate pair maps to the code point containing it. That
 * case does not arise from real token boundaries, which always fall between
 * code points.
 */
export function makeCpIndexer(s) {
  if (!/[\uD800-\uDFFF]/.test(s)) return (u) => Math.min(Math.max(u, 0), s.length);
  const map = new Int32Array(s.length + 1);
  let cp = 0;
  let u = 0;
  while (u < s.length) {
    const size = s.codePointAt(u) > 0xffff ? 2 : 1;
    for (let k = 0; k < size; k += 1) map[u + k] = cp;
    u += size;
    cp += 1;
  }
  map[s.length] = cp;
  return (at) => map[Math.min(Math.max(at, 0), s.length)];
}

/** Case-fold one code point; tolerates Turkish/Azeri dotted İ → i. */
export const foldChar = (c) => {
  const l = c.toLowerCase();
  return l === 'i̇' ? 'i' : l;
};

/**
 * Does `body` (at UTF-16 index `at`) case-foldedly start with `form`?
 * Returns the UTF-16 index just past the match, or false.
 */
export function matchesAt(body, at, form) {
  let i = at;
  for (const fc of form) {
    if (i >= body.length) return false;
    const bc = String.fromCodePoint(body.codePointAt(i));
    if (foldChar(bc) !== foldChar(fc)) return false;
    i += bc.length;
  }
  return i;
}

/** Leipzig morpheme joints. */
const JOINT_RE = /([-=])/;

/**
 * Split an analyzed word into morpheme pieces.
 * "perro=s" → [{form:'perro', before:null}, {form:'s', before:'='}]
 */
export function splitAnalyzed(word) {
  const parts = String(word ?? '').split(JOINT_RE);
  const pieces = [];
  let before = null;
  for (const part of parts) {
    if (part === '-' || part === '=') {
      before = part;
      continue;
    }
    pieces.push({ form: part, before });
    before = null;
  }
  return pieces.length ? pieces : [{ form: '', before: null }];
}

/** The surface form of an analyzed word: its pieces with the joints removed. */
export const surfaceOf = (word) =>
  splitAnalyzed(word)
    .map((p) => p.form)
    .join('');

// Punctuation and symbols, minus emoji: the same rule the app's ignored-token
// config applies to whole tokens (domain/igtConfig.js).
const PUNCT_RE = /[\p{P}\p{S}]/u;
const PICTOGRAPH_RE = /\p{Extended_Pictographic}/u;
const isPunct = (c) => PUNCT_RE.test(c) && !PICTOGRAPH_RE.test(c);

/** The whitespace-delimited runs of body[begin, end), as UTF-16 spans. */
function textRuns(body, begin, end) {
  const runs = [];
  let i = begin;
  while (i < end) {
    while (i < end && /\s/.test(body[i])) i += 1;
    if (i >= end) break;
    const start = i;
    while (i < end && !/\s/.test(body[i])) i += 1;
    runs.push({ beginU16: start, endU16: i });
  }
  return runs;
}

/** A run with its edge punctuation dropped, never trimmed away to nothing. */
function trimEdges(body, run) {
  let { beginU16: b, endU16: e } = run;
  while (b < e && isPunct(body[b])) b += 1;
  while (e > b && isPunct(body[e - 1])) e -= 1;
  return b < e ? { beginU16: b, endU16: e } : run;
}

/**
 * Does `form` occur in this run, verbatim or joint-stripped?
 *
 * Deliberately a yes/no, not a span. The joint-stripped candidate is the
 * morpheme pieces concatenated, which says what the analysis claims the word
 * IS, never where it sits: Plaid morphemes carry no extent of their own (they
 * span their word, ordered by precedence, with the form in metadata), so a
 * decomposition has no boundary to contribute. It is the text, via whitespace,
 * that says where a word ends. Letting this measure rather than select is what
 * once clipped Tsez *yegirxo* to the "yegirx" its analysis spells out.
 */
function occursIn(body, run, form) {
  const candidates = [...new Set([form, surfaceOf(form)])].filter((c) => c !== '');
  for (const c of candidates) {
    for (let at = run.beginU16; at <= run.endU16; at += 1) {
      const hit = matchesAt(body, at, c);
      if (hit !== false && hit <= run.endU16) return true;
    }
  }
  return false;
}

/**
 * Align an ordered list of analyzed words against body[begin, end).
 *
 * CLDF calls Analyzed_Word "the sequence of words of the primary text to be
 * aligned with glosses", and that correspondence is POSITIONAL. It is not a
 * promise that the analyzed form occurs in the text: real corpora routinely
 * give the morphophonemic form, so Tsez writes "Allah-s" for surface
 * *Allahes*, "b-ukad-n" for *bukayn*, "yisi-a" for *yisä*. In the Tsez
 * Annotated Corpus only 2.4% of lines have analyzed words that concatenate
 * back to their own primary text, so matching characters cannot be the primary
 * strategy the way it is for FLEx (where the analysis IS derived from the
 * surface).
 *
 * So: walk the text's whitespace-delimited runs and the analyzed words in
 * lockstep. A word is always one run, minus edge punctuation, because the text
 * is what says where words end. A character match only picks WHICH run a form
 * belongs to, and only when there are spare runs to skip: looking ahead is
 * allowed by the number of runs the analysis can afford to give up (extra runs
 * are punctuation the analysis left out), which keeps the two sequences in step
 * and cannot drift. When the counts agree, the slack is zero and the alignment
 * is purely positional.
 *
 * Returns {spans: [{beginU16, endU16} | null], warnings}.
 */
export function alignWords(body, begin, end, forms) {
  const runs = textRuns(body, begin, end);
  const spans = [];
  const warnings = [];
  let ri = 0;

  forms.forEach((form, fi) => {
    // How many runs we may skip without starving the forms still to come.
    const slack = Math.max(0, runs.length - ri - (forms.length - fi));
    let hit = -1;
    for (let j = ri; j <= Math.min(ri + slack, runs.length - 1); j += 1) {
      if (occursIn(body, runs[j], form)) {
        hit = j;
        break;
      }
    }
    if (hit >= 0) {
      // Cover the whole run, not just the matched part. A run is consumed by
      // at most one form, so whatever the analysis does not account for
      // belongs to no other token: Tsez writes "yegirxo" but analyzes it as
      // "y-egir-x", and matching alone left that final "o" outside every
      // word, where it could not be annotated and would not tile on export.
      // Edge punctuation still stays out, so "zown." keeps its full stop
      // separate. The morpheme forms are unaffected, since they live in token
      // metadata rather than in the text extent.
      spans.push(trimEdges(body, runs[hit]));
      ri = hit + 1;
      return;
    }
    if (ri < runs.length) {
      // No character match. The positional correspondence is what the format
      // actually asserts, so trust it and take the whole word.
      spans.push(trimEdges(body, runs[ri]));
      ri += 1;
      return;
    }
    warnings.push(`no text left to align "${form}" to`);
    spans.push(null);
  });

  if (runs.length !== forms.length && forms.length) {
    warnings.push(
      `${forms.length} analyzed words for ${runs.length} words of text; aligned by position`,
    );
  }
  return { spans, warnings };
}
