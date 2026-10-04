// The words a Baseline save adds to the text it types, when the project's
// "Tokenize new text" is on (the word layer's `igt.tokenizeNewText`). They go
// in the same request as the text edit, so the edit and its words land or are
// refused together.
//
// The words are measured on the body the edit makes, before the server has
// placed the existing words on it. So this reads which new positions an
// existing word may end up over, and keeps every new word off them:
// - a word's own text, moved by the edit;
// - all the text a gap types when the gap reaches inside a word or takes one
//   whole (the server may grow, keep or read the word over any of it);
// - the text typed against a word's edge with no whitespace between, which
//   the server gives that word.
// What is left over, where the save typed something, is split by the
// built-in tokenizer (the one the Tokenize tab runs, reading the project's
// ignored tokens). A stretch with a word over any of it is never touched.
//
// Left whole: a stretch that is only ignored characters, and every stretch of
// a spaceless sentence, one whose text (line breaks aside) has letters and no
// whitespace, such as a line of Chinese. A one-word sentence counts as
// spaceless too.

import { cpSlice } from '@larc-iu/plaid-client';
import { lineSentenceRanges, tokenizeText } from '../utils/tokenizationUtils.js';
import { isTokenIgnored } from './igtConfig.js';

const isSpace = (c) => /\s/u.test(c);
const SPACE_IN_LINE = /[^\S\n\r\u0085\u2028\u2029]/u;
const LETTER = /\p{L}/u;

/** A sentence's text, as the spaceless rule reads it. */
export const isSpaceless = (text) => {
  const t = String(text ?? '').trim();
  return LETTER.test(t) && !SPACE_IN_LINE.test(t);
};

/**
 * The words to create with a save of `gaps` over `base`.
 * @param {object} save
 * @param {string} save.base - the stored body the gaps are of
 * @param {Array<{start:number,end:number,value:string}>} save.gaps - code
 *   points of `base`, in order, not overlapping (plaid-ui's editLog shape)
 * @param {Array<{begin:number,end:number}>} save.words - the words on `base`
 * @param {Array<{begin:number,end:number}>|null} save.sentences - the
 *   sentences on `base`, or null when the save makes them, one a line
 * @param {object|null} save.ignored - the ignored-tokens rule
 * @returns {Array<{begin:number,end:number}>} new words, in code points of
 *   the body the save makes, in order
 */
export function newTextWords({ base, gaps, words, sentences, ignored }) {
  const old = Array.from(base ?? '');
  const sorted = [...(gaps || [])].sort((a, b) => a.start - b.start);
  const body = [];
  const typed = [];
  const at = [];
  const lens = [];
  let pos = 0;
  for (const g of sorted) {
    for (let i = pos; i < g.start; i++) {
      body.push(old[i]);
      typed.push(false);
    }
    at.push(body.length);
    const value = Array.from(g.value ?? '');
    lens.push(value.length);
    for (const c of value) {
      body.push(c);
      typed.push(true);
    }
    pos = g.end;
  }
  for (let i = pos; i < old.length; i++) {
    body.push(old[i]);
    typed.push(false);
  }
  const n = body.length;
  if (!typed.some(Boolean)) return [];

  // The last gap starting at or before `p` (or strictly before it), or -1.
  const lastStarting = (p, strict) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (strict ? sorted[m].start < p : sorted[m].start <= p) lo = m + 1;
      else hi = m;
    }
    return lo - 1;
  };
  const after = (i, p) => p - sorted[i].end + at[i] + lens[i];
  // Where an old start lands: after text inserted right at it, at the start
  // of the text that replaced it.
  const startOf = (p) => {
    const i = lastStarting(p, false);
    if (i < 0) return p;
    const g = sorted[i];
    if (g.start === p && g.end === p) return at[i] + lens[i];
    if (g.start <= p && p < g.end) return at[i];
    return after(i, p);
  };
  // Where an old end lands: before text inserted right at it, at the end of
  // the text that replaced it.
  const endOf = (p) => {
    const j = lastStarting(p, false);
    if (j >= 0 && sorted[j].start === p && sorted[j].end === p) return at[j];
    const i = lastStarting(p, true);
    if (i < 0) return p;
    if (p <= sorted[i].end) return at[i] + lens[i];
    return after(i, p);
  };

  const covered = new Uint8Array(n);
  for (const w of words || []) {
    if (!(w.begin < w.end)) continue;
    const lo = startOf(w.begin);
    const hi = endOf(w.end);
    for (let x = Math.max(0, lo); x < Math.min(n, hi); x++) covered[x] = 1;
  }
  // Typed text against a word with no whitespace between goes to the word.
  const joins = (x) => typed[x] && !isSpace(body[x]);
  for (let x = 1; x < n; x++) if (!covered[x] && covered[x - 1] && joins(x)) covered[x] = 1;
  for (let x = n - 2; x >= 0; x--) if (!covered[x] && covered[x + 1] && joins(x)) covered[x] = 1;

  const ranges = [];
  for (let x = 0; x < n; ) {
    if (covered[x]) {
      x++;
      continue;
    }
    let y = x;
    while (y < n && !covered[y]) y++;
    ranges.push({ start: x, end: y });
    x = y;
  }
  const text = body.join('');
  const found = tokenizeText(text, ignored ?? null, ranges);

  const lines = sentences
    ? sentenceRanges(sentences, startOf, n)
    : lineSentenceRanges(text).map(({ begin, end }) => [begin, end]);
  const spaceless = lines.map(([b, e]) => isSpaceless(cpSlice(text, b, e)));
  let s = 0;
  const out = [];
  for (const t of found) {
    let has = false;
    for (let x = t.begin; x < t.end && !has; x++) has = typed[x];
    if (!has || isTokenIgnored(t.text, ignored ?? null)) continue;
    while (s + 1 < lines.length && lines[s + 1][0] <= t.begin) s++;
    if (spaceless[s]) continue;
    out.push({ begin: t.begin, end: t.end });
  }
  return out;
}

// The sentences on the new body, as [begin, end) pairs: each old sentence's
// start moved by the edit (text typed where two meet goes to the one before),
// the first at 0.
function sentenceRanges(sentences, startOf, n) {
  const starts = [0];
  for (const s of [...sentences].sort((a, b) => a.begin - b.begin)) {
    if (s.begin <= 0) continue;
    const p = startOf(s.begin);
    if (p > starts[starts.length - 1] && p < n) starts.push(p);
  }
  return starts.map((b, i) => [b, i + 1 < starts.length ? starts[i + 1] : n]);
}
