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
// Each gap is first trimmed of the text its value shares with what it
// replaces at either end, as the server reads it (plaid-core's `trim-gap`,
// plaid-ui editLog's `trimGaps`): a selection `two` typed over as
// `two plus` is `plus` typed after `two`, and a line pasted over itself
// with a word added is that word typed.
// What is left over, where the save typed something, is split by the
// built-in tokenizer (the one the Tokenize tab runs, reading the project's
// ignored tokens). A stretch with a word over any of it is never touched.
//
// Left without words: a stretch that is only ignored characters, and a
// spaceless stretch, one holding a letter of a script written without spaces
// between words (Han, kana, Thai, Khmer and the like, spacelessScripts.js).
// The tokenizer cuts at whitespace and punctuation, so in a line that mixes
// scripts each stretch is judged on its own: `我用 Plaid 写` gives `Plaid`
// a word, and `我用Plaid写`, one stretch, gets none.

import { tokenizeText } from '../utils/tokenizationUtils.js';
import { isTokenIgnored } from './igtConfig.js';
import { isSpacelessScript } from './spacelessScripts.js';

const isSpace = (c) => /\s/u.test(c);

/** Whether a stretch holds a letter of a script written without spaces. */
export const isSpaceless = (text) => Array.from(String(text ?? '')).some(isSpacelessScript);

// `gaps` over the code points `old`, each without the text its value shares
// with the old at either end, and none that is left with nothing.
function trimmed(old, gaps) {
  const out = [];
  for (const g of gaps || []) {
    const value = Array.from(g.value ?? '');
    const k = g.end - g.start;
    let front = 0;
    while (front < value.length && front < k && value[front] === old[g.start + front]) front += 1;
    let back = 0;
    while (
      back < value.length - front &&
      back < k - front &&
      value[value.length - 1 - back] === old[g.end - 1 - back]
    ) {
      back += 1;
    }
    if (front + back === value.length && front + back === k) continue;
    out.push({
      ...g,
      start: g.start + front,
      end: g.end - back,
      value: value.slice(front, value.length - back).join(''),
    });
  }
  return out;
}

/**
 * The words to create with a save of `gaps` over `base`.
 * @param {object} save
 * @param {string} save.base - the stored body the gaps are of
 * @param {Array<{start:number,end:number,value:string}>} save.gaps - code
 *   points of `base`, in order, not overlapping (plaid-ui's editLog shape)
 * @param {Array<{begin:number,end:number}>} save.words - the words on `base`
 * @param {object|null} save.ignored - the ignored-tokens rule
 * @param {Array<{begin:number,end:number}>} [save.sentences] - the sentences
 *   on `base`: no new word crosses one of their boundaries
 * @returns {Array<{begin:number,end:number}>} new words, in code points of
 *   the body the save makes, in order
 */
export function newTextWords({ base, gaps, words, ignored, sentences = [] }) {
  const old = Array.from(base ?? '');
  const sorted = trimmed(old, gaps).sort((a, b) => a.start - b.start);
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
  // The sentence boundaries, moved by the edit, cut every candidate: a word
  // is never made across one (the word layer lies inside the sentences).
  // Text typed at a boundary goes to the sentence before, as the server puts
  // it. Where a gap that deletes reaches a boundary, which sentence its typed
  // text lands in is the server's to say, so that text gets no word.
  const cut = new Uint8Array(n + 1);
  for (const s of sentences || []) {
    const p = s.begin;
    if (!(p > 0 && p < old.length)) continue;
    const touching = [];
    const i = lastStarting(p, false);
    for (let j = Math.max(0, i - 1); j <= i; j++) {
      if (j >= 0 && sorted[j].start <= p && p <= sorted[j].end) touching.push(j);
    }
    if (!touching.length) {
      cut[startOf(p)] = 1;
    } else if (touching.every((j) => sorted[j].start === p && sorted[j].end === p)) {
      cut[at[touching.at(-1)] + lens[touching.at(-1)]] = 1;
    } else {
      for (const j of touching) {
        cut[at[j]] = 1;
        cut[at[j] + lens[j]] = 1;
        for (let x = at[j]; x < at[j] + lens[j]; x++) covered[x] = 1;
      }
    }
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
    while (y < n && !covered[y] && !(y > x && cut[y])) y++;
    ranges.push({ start: x, end: y });
    x = y;
  }
  const text = body.join('');
  const found = tokenizeText(text, ignored ?? null, ranges);

  const out = [];
  for (const t of found) {
    let has = false;
    for (let x = t.begin; x < t.end && !has; x++) has = typed[x];
    if (!has || isTokenIgnored(t.text, ignored ?? null) || isSpaceless(t.text)) continue;
    out.push({ begin: t.begin, end: t.end });
  }
  return out;
}
