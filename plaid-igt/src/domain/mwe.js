// Multi-word MWEs (MWEs): one lexicon entry linked from two or more WORD tokens
// at once. The data model needs nothing new — a vocab link already carries a
// `tokens` list, and plaid-core checks that the members share a document, a
// text and a token layer — so an MWE is simply a link with two or more
// tokens, kept in text order. Pure helpers here are shared by derive.js (which
// works out how each word column draws its share of the bracket), the editor
// (which turns a selection into a new entry's form and type) and the
// validators.

import { provState } from '@larc-iu/plaid-client';

export const isMweLink = (link) =>
  Array.isArray(link?.tokens) && link.tokens.length >= 2 && !!link.vocabItem;

/** Every MWE link across the project's vocabularies. */
export function collectMweLinks(vocabularies) {
  const out = [];
  Object.values(vocabularies || {}).forEach((vocab) => {
    (vocab.vocabLinks || []).forEach((link) => {
      if (!isMweLink(link)) return;
      out.push({
        linkId: link.id,
        vocabId: vocab.id,
        vocabName: vocab.name,
        item: {
          id: link.vocabItem.id,
          form: link.vocabItem.form,
          metadata: link.vocabItem.metadata || {},
        },
        tokenIds: [...link.tokens],
        metadata: link.metadata || {},
        prov: provState(link.metadata || {}),
      });
    });
  });
  return out;
}

/**
 * Which piece of the bracket each of `n` columns draws for an MWE whose
 * members sit at the sorted positions `memberIdx`: 'start' on the first
 * member, 'end' on the last, 'mid' on a member in between, 'pass' (a dotted
 * run) on a skipped word in between, and null outside the MWE. Every
 * column draws its own piece, which is what lets a bracket survive the grid's
 * band wrapping without anything measuring the columns.
 */
export function bracketPieces(n, memberIdx) {
  const out = new Array(n).fill(null);
  if (!Array.isArray(memberIdx) || memberIdx.length < 2) return out;
  const sorted = [...memberIdx].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const members = new Set(sorted);
  for (let i = first; i <= last; i++) {
    if (i === first) out[i] = 'start';
    else if (i === last) out[i] = 'end';
    else out[i] = members.has(i) ? 'mid' : 'pass';
  }
  return out;
}

/**
 * First-fit lane assignment for the MWEs of one sentence. `spans` is
 * [{first, last}] (column indices); returns the lane of each, in input order.
 * Two MWEs share a lane only when their column ranges are disjoint: a
 * skipped word still carries the dotted pass-through, so it is the ranges
 * that collide, not the member sets. Earlier MWEs take lower lanes;
 * among MWEs starting on the same column the longer one goes first,
 * so a short MWE nested at the start of a long one sits beneath it.
 */
export function assignLanes(spans) {
  const order = spans
    .map((_, i) => i)
    .sort(
      (a, b) =>
        spans[a].first - spans[b].first ||
        spans[b].last - spans[b].first - (spans[a].last - spans[a].first),
    );
  const laneEnds = [];
  const lanes = new Array(spans.length);
  for (const i of order) {
    const { first, last } = spans[i];
    let lane = laneEnds.findIndex((end) => end < first);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(last);
    } else {
      laneEnds[lane] = last;
    }
    lanes[i] = lane;
  }
  return lanes;
}

/** Are the sorted member positions one unbroken run? */
export const isContiguous = (memberIdx) => {
  if (!Array.isArray(memberIdx) || memberIdx.length === 0) return true;
  const sorted = [...memberIdx].sort((a, b) => a - b);
  return sorted[sorted.length - 1] - sorted[0] === sorted.length - 1;
};

/**
 * The morph type a new MWE entry gets, from the FieldWorks inventory
 * (affixMarkers.js): a run of adjacent words is a `phrase`, anything with a
 * word skipped in the middle a `discontiguous phrase`.
 */
export const mweMorphType = (memberIdx) =>
  isContiguous(memberIdx) ? 'phrase' : 'discontiguous phrase';

export const isMweType = (morphType) =>
  typeof morphType === 'string' && morphType.toLowerCase().includes('phrase');

/** The form a new MWE entry is offered: the member surfaces, spaced. */
export const joinMweForm = (surfaces) =>
  (surfaces || [])
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ');
