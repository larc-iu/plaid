// Data-integrity invariants for the bug bash. Each takes a freshly-loaded
// IgtDocument (server truth) and returns an array of violation strings (empty =
// OK). Plus a comparison for optimistic-vs-server divergence.
//
// All offsets are CODE POINTS. Use the doc's layerInfo, which exposes the raw
// token layers with begin/end/metadata intact.

import { cpLength } from '@larc-iu/plaid-client';

const align = (doc) => doc.layerInfo?.alignmentTokenLayer?.tokens || [];
const sentences = (doc) => doc.layerInfo?.sentenceTokenLayer?.tokens || [];
const words = (doc) => doc.layerInfo?.primaryTokenLayer?.tokens || [];
const morphemes = (doc) => doc.layerInfo?.morphemeTokenLayer?.tokens || [];

// Two half-open ranges [a,b) [c,d) overlap iff a<d && b>c.
const overlaps = (a, b, c, d) => a < d && b > c;

// Every token offset is within [0, len] and well-formed (begin < end).
export function tokenOffsetsInBounds(doc) {
  const len = cpLength(doc.body || '');
  const v = [];
  const check = (toks, label) => {
    for (const t of toks) {
      if (t.begin == null || t.end == null) { v.push(`${label} ${t.id}: null offset (begin=${t.begin} end=${t.end})`); continue; }
      if (t.begin < 0) v.push(`${label} ${t.id}: begin<0 (${t.begin})`);
      if (t.end > len) v.push(`${label} ${t.id}: end>bodyLen (${t.end} > ${len})`);
      if (t.begin >= t.end) v.push(`${label} ${t.id}: begin>=end (${t.begin}>=${t.end}) [zero/neg width]`);
    }
  };
  check(align(doc), 'alignment');
  check(words(doc), 'word');
  check(sentences(doc), 'sentence');
  // morphemes may legitimately share extent; only flag out-of-bounds, not width.
  for (const m of morphemes(doc)) {
    if (m.begin < 0 || m.end > len || m.begin > m.end) v.push(`morpheme ${m.id}: out of bounds (${m.begin},${m.end}) len=${len}`);
  }
  return v;
}

// No two alignment tokens may overlap on the text axis.
export function noOverlappingAlignments(doc) {
  const toks = [...align(doc)].sort((a, b) => a.begin - b.begin);
  const v = [];
  for (let i = 0; i < toks.length; i++) {
    for (let j = i + 1; j < toks.length; j++) {
      if (overlaps(toks[i].begin, toks[i].end, toks[j].begin, toks[j].end)) {
        v.push(`alignments overlap: ${toks[i].id}[${toks[i].begin},${toks[i].end}) ∩ ${toks[j].id}[${toks[j].begin},${toks[j].end})`);
      }
    }
  }
  return v;
}

// Temporal order (timeBegin) must match positional order (begin). If alignment
// A starts earlier in time than B but later in the text, that's an inversion —
// exactly the conflict alignment.js tries to prevent.
export function alignmentTimeOrderMatchesText(doc) {
  const toks = align(doc)
    .map((t) => ({ id: t.id, begin: t.begin, tb: t.metadata?.timeBegin ?? 0 }))
    .sort((a, b) => a.tb - b.tb);
  const v = [];
  for (let i = 1; i < toks.length; i++) {
    if (toks[i].begin < toks[i - 1].begin) {
      v.push(`temporal/positional inversion: ${toks[i - 1].id}(t=${toks[i - 1].tb},pos=${toks[i - 1].begin}) then ${toks[i].id}(t=${toks[i].tb},pos=${toks[i].begin})`);
    }
  }
  return v;
}

// The sentence layer is :partitioning — its tokens must exactly tile [0, len)
// with no gaps and no overlaps (when len>0).
export function partitionCoversBody(doc) {
  const len = cpLength(doc.body || '');
  const toks = [...sentences(doc)].sort((a, b) => a.begin - b.begin);
  const v = [];
  if (len === 0) {
    if (toks.length > 0) v.push(`empty body but ${toks.length} sentence token(s)`);
    return v;
  }
  if (toks.length === 0) { v.push(`body len ${len} but NO sentence tokens (unpartitioned)`); return v; }
  if (toks[0].begin !== 0) v.push(`partition does not start at 0 (first begin=${toks[0].begin})`);
  if (toks[toks.length - 1].end !== len) v.push(`partition does not end at body len (last end=${toks[toks.length - 1].end}, len=${len})`);
  for (let i = 1; i < toks.length; i++) {
    if (toks[i].begin !== toks[i - 1].end) {
      v.push(`partition gap/overlap between ${toks[i - 1].id}[..${toks[i - 1].end}) and ${toks[i].id}[${toks[i].begin}..)`);
    }
  }
  return v;
}

// Word & morpheme tokens must fall inside some sentence (no orphan tokens
// pointing outside the partition). Cheap structural sanity check.
export function wordsInsidePartition(doc) {
  const sents = sentences(doc);
  const len = cpLength(doc.body || '');
  const v = [];
  if (!sents.length || len === 0) return v;
  for (const w of words(doc)) {
    const host = sents.find((s) => w.begin >= s.begin && w.end <= s.end);
    if (!host) v.push(`word ${w.id}[${w.begin},${w.end}) not contained in any sentence`);
  }
  return v;
}

// Corruption sniff: U+FFFD replacement chars suggest a botched encode/slice.
export function noReplacementChars(doc) {
  const body = doc.body || '';
  return body.includes('�') ? [`body contains U+FFFD replacement char (encoding corruption?)`] : [];
}

export const ALL_INVARIANTS = {
  tokenOffsetsInBounds,
  noOverlappingAlignments,
  alignmentTimeOrderMatchesText,
  partitionCoversBody,
  wordsInsidePartition,
  noReplacementChars,
};

// Run every invariant; return { ok, violations: [{name, msg}] }.
export function runAllInvariants(doc) {
  const violations = [];
  for (const [name, fn] of Object.entries(ALL_INVARIANTS)) {
    for (const msg of fn(doc)) violations.push({ name, msg });
  }
  return { ok: violations.length === 0, violations };
}

// ---- optimistic-vs-server divergence ------------------------------------
// For ops that DON'T _reload (alignBaseline, updateAlignmentBounds, metadata),
// the optimistic in-memory doc should match a fresh server load.
const sig = (toks) => [...toks]
  .map((t) => `[${t.begin},${t.end})@${t.metadata?.timeBegin ?? '-'}..${t.metadata?.timeEnd ?? '-'}`)
  .sort()
  .join(' ');

export function optimisticMatchesServer(optimisticDoc, serverDoc) {
  const v = [];
  if ((optimisticDoc.body || '') !== (serverDoc.body || '')) {
    v.push(`body diverged:\n  optimistic="${optimisticDoc.body}"\n  server   ="${serverDoc.body}"`);
  }
  if (sig(align(optimisticDoc)) !== sig(align(serverDoc))) {
    v.push(`alignment tokens diverged:\n  optimistic=${sig(align(optimisticDoc))}\n  server    =${sig(align(serverDoc))}`);
  }
  const ssig = (d) => [...sentences(d)].map((t) => `[${t.begin},${t.end})`).sort().join(' ');
  if (ssig(optimisticDoc) !== ssig(serverDoc)) {
    v.push(`sentence tokens diverged:\n  optimistic=${ssig(optimisticDoc)}\n  server    =${ssig(serverDoc)}`);
  }
  return v;
}
