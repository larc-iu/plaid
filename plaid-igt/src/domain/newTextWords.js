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
//   the server gives that word, unless the word is made only of punctuation
//   (a token over `(` or `.`), which takes none.
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

import { isTextPunctuation, isWordSpace } from '../../../plaid-ui/src/domain/igtWordBreaks.js';
import { tokenizeText } from '../utils/tokenizationUtils.js';
import { isTokenIgnored } from './igtConfig.js';
import { isSpacelessScript } from './spacelessScripts.js';

// Whitespace, NEL included (plaid-core `space?`).
const isSpace = isWordSpace;
const isLineBreak = (c) => /[\n\r\u0085\u2028\u2029]/u.test(c);
// Punctuation to core's text rule (plaid-core `punct?`), under the project's
// rule. A word made only of it takes no text typed against it, and text typed
// right after it goes to the sentence after.
const isPunctOnly = (cs, ignored) =>
  cs.length > 0 && cs.every((c) => isTextPunctuation(c, ignored));

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
 * Where a save of `gaps` over `base` may make words: the body it makes, which
 * of its code points the save typed, which an existing word may end up over
 * (`covered`), and where core puts a sentence boundary in it (`cut`, 1 at
 * each such position). `sentenceCutCases.test.js` holds `cut` to core's on
 * plaid-core's shared case table. Null when the save types nothing.
 * @param {object} save - as `newTextWords` takes it
 * @param {string} save.base
 * @param {Array<{start:number,end:number,value:string}>} save.gaps
 * @param {Array<{begin:number,end:number}>} save.words
 * @param {Array<{begin:number,end:number}>} [save.sentences]
 * @param {object|null} [save.ignored] - the ignored-tokens rule, whose
 *   letter-like characters are no punctuation to core
 * @returns {{body: string[], typed: boolean[], covered: Uint8Array, cut: Uint8Array}|null}
 */
export function newTextLayout({ base, gaps, words, sentences = [], ignored = null }) {
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
  if (!typed.some(Boolean)) return null;

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
  // What typed text against it with no whitespace between goes to: all that
  // is covered but the text of a word made only of punctuation, which takes
  // none (plaid-core `apply-plain-gaps`).
  const takes = new Uint8Array(n);
  for (const w of words || []) {
    if (!(w.begin < w.end)) continue;
    const lo = startOf(w.begin);
    const hi = endOf(w.end);
    const punct = isPunctOnly(old.slice(w.begin, w.end), ignored);
    for (let x = Math.max(0, lo); x < Math.min(n, hi); x++) {
      covered[x] = 1;
      // (text a gap typed inside it, which the server may give it, does)
      if (!punct || typed[x]) takes[x] = 1;
    }
  }
  // The sentence boundaries, moved by the edit, cut every candidate: a word
  // is never made across one (the word layer lies inside the sentences).
  // Text typed between two sentences goes where the server puts it: to the
  // one after when typed past whitespace on that sentence's first line, or
  // right after the punctuation the one before ends on, else to the one
  // before (plaid-core `apply-plain-gaps`). Where a gap that deletes reaches
  // a boundary, which sentence its typed text lands in is the server's to
  // say, so that text gets no word. Past whitespace, the text goes to the
  // first sentence beginning at or after it, and so does the text of every
  // other insert in the same whitespace before it (`run-start`, `run-at`).
  const begins = (sentences || []).map((s) => s.begin);
  const noBegin = (a, x) => !begins.some((b) => a <= b && b < x);
  // The next letter's position for an insert after whitespace with no line
  // break in it or between it and that letter, else null.
  const nextLetter = sorted.map(({ start: a, end: b, value }) => {
    if (a !== b || !(a > 0 && a < old.length) || !isSpace(old[a - 1])) return null;
    if (Array.from(value ?? '').some(isLineBreak)) return null;
    for (let x = a; x < old.length; x++) {
      if (!isSpace(old[x])) return x;
      if (isLineBreak(old[x])) return null;
    }
    return null;
  });
  const runStart = [];
  sorted.forEach((_, j) => {
    runStart.push(
      j > 0 && nextLetter[j] !== null && nextLetter[j - 1] === nextLetter[j] ? runStart[j - 1] : j,
    );
  });
  const toNext = (j, p) => {
    const { start: a, end: b, value } = sorted[j];
    if (a !== b || a > p || !(a > 0 && a < old.length)) return false;
    if (Array.from(value ?? '').some(isLineBreak)) return false;
    if (!isSpace(old[a - 1])) {
      return a === p && !isSpace(old[a]) && isTextPunctuation(old[a - 1], ignored);
    }
    return nextLetter[j] !== null && p <= nextLetter[j] && noBegin(a, p);
  };
  // Where the sentence beginning at `p` begins when `toNext(j, p)`.
  const runAt = (j, p) => {
    let h = j;
    while (h > runStart[j] && noBegin(sorted[h - 1].start, p)) h -= 1;
    return at[h];
  };
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
      cut[i >= 0 && toNext(i, p) ? runAt(i, p) : startOf(p)] = 1;
    } else if (touching.every((j) => sorted[j].start === p && sorted[j].end === p)) {
      const j = touching.at(-1);
      cut[toNext(j, p) ? runAt(j, p) : at[j] + lens[j]] = 1;
    } else {
      for (const j of touching) {
        cut[at[j]] = 1;
        cut[at[j] + lens[j]] = 1;
        for (let x = at[j]; x < at[j] + lens[j]; x++) {
          covered[x] = 1;
          takes[x] = 1;
        }
      }
    }
  }

  // A line typed before the first sentence's first letter left, holding a
  // letter before its last line break, is a sentence of its own: the first
  // sentence begins at the first letter after that line (plaid-core
  // `apply-plain-gaps`, `head-end`). "A letter" is anything but whitespace
  // (NEL included), so a line of only no-break or ideographic spaces (an
  // indent) or of NEL is not one.
  // Not where a word the save typed over with the line
  // ends inside it, which core keeps on its own text.
  const first = (sentences || []).find((s) => s.begin === 0);
  if (first) {
    const inGap = (x) => sorted.some((g) => g.start <= x && x < g.end);
    let q = -1;
    for (let x = 0; x < Math.min(first.end, old.length); x++) {
      if (!isSpace(old[x]) && !inGap(x)) {
        q = x;
        break;
      }
    }
    if (q >= 0) {
      const p = startOf(q);
      let k = -1;
      for (let x = p - 1; x >= 0; x--) {
        if (isLineBreak(body[x])) {
          k = x + 1;
          break;
        }
      }
      const letter = k > 0 && body.slice(0, k).some((c) => !isSpace(c));
      const typedOver = (words || []).some(
        (w) =>
          w.begin < w.end &&
          sorted.some((g) => g.start <= w.begin && w.end <= g.end && g.value) &&
          endOf(w.end) <= k,
      );
      if (letter && !typedOver) {
        const e = endOf(first.end);
        let b = k;
        while (b < e && isSpace(body[b])) b += 1;
        cut[Math.min(b, e - 1)] = 1;
      }
    }
  }

  // Typed text against a word with no whitespace between goes to the word,
  // unless the word is made only of punctuation.
  const joins = (x) => typed[x] && !isSpace(body[x]);
  for (let x = 1; x < n; x++) {
    if (!covered[x] && takes[x - 1] && joins(x)) covered[x] = takes[x] = 1;
  }
  for (let x = n - 2; x >= 0; x--) {
    if (!covered[x] && takes[x + 1] && joins(x)) covered[x] = takes[x] = 1;
  }
  return { body, typed, covered, cut };
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
  const layout = newTextLayout({ base, gaps, words, sentences, ignored });
  if (!layout) return [];
  const { body, typed, covered, cut } = layout;
  const n = body.length;
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
