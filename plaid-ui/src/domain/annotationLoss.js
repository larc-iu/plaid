// What a delete or a split takes with it, counted on every layer of a text,
// whichever app made it, the way core's cascade and layer rules take it. No
// app is named here: a count is by layer, so an annotation layer that comes
// along later is counted like every other.
//
// The input is a text layer's token layers as the document read holds them
// (`textLayers[].tokenLayers`, each with `tokens`, `spanLayers[].spans`,
// `spanLayers[].relationLayers[].relations` and `vocabs[].vocabLinks`).
//
// Deleting a token deletes, in the same transaction:
//   - every token of a layer nested (transitively) under its layer whose
//     extent lies within it (begin >= its begin, end <= its end),
//   - every span on a token that goes (one that keeps some of its tokens is
//     cut down to them, which is counted as well, since it no longer says
//     what it said),
//   - every relation with an end on a span left with no tokens,
//   - every vocabulary link on a token that goes (cut down, like a span, when
//     it keeps some of its tokens).
// Splitting a token deletes every relation on a layer that declares
// `same-ancestor` over the split token's layer and whose ends then lie in
// different halves.
//
// No bare imports: plaid-ud's node suite imports this file by path.

import { PROVENANCE_KEYS } from '../../../plaid-client-js/src/provenance.js';

const EMPTY = () => ({
  annotations: 0,
  spans: 0,
  relations: 0,
  content: 0,
  links: 0,
  byLayer: new Map(),
});

const bump = (map, key, n = 1) => map.set(key, (map.get(key) || 0) + n);

// A token's metadata holds something of its own beyond provenance.
export const hasOwnContent = (token) =>
  Object.keys(token?.metadata || {}).some((k) => !PROVENANCE_KEYS.includes(k));

// Token layer id -> the token layers directly under it.
const childrenByParent = (tokenLayers) => {
  const childrenOf = new Map();
  for (const tl of tokenLayers || []) {
    if (!tl?.parentTokenLayer) continue;
    if (!childrenOf.has(tl.parentTokenLayer)) childrenOf.set(tl.parentTokenLayer, []);
    childrenOf.get(tl.parentTokenLayer).push(tl);
  }
  return childrenOf;
};

// The token layers nested (transitively) under `layerId`.
const nestedUnder = (childrenOf, layerId) => {
  const out = [];
  const queue = [layerId];
  while (queue.length) {
    for (const child of childrenOf.get(queue.shift()) || []) {
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
};

const within = (outer, t) => t.begin >= outer.begin && t.end <= outer.end;

// Whether the caller counts this layer (or the layer it hangs on) itself.
const skipper = (skip) => {
  const set = skip instanceof Set ? skip : new Set(skip || []);
  return (...ids) => ids.some((id) => id != null && set.has(id));
};

/**
 * Count what deleting the tokens `tokenIds` takes with it.
 *
 * @param {object[]} tokenLayers a text layer's token layers, every app's
 * @param {Iterable<string>} tokenIds the tokens deleted
 * @param {object} [options]
 * @param {boolean} [options.under] the given tokens stay and only what is
 *   nested under them goes (a merge or a split that takes a word's morphemes)
 * @param {Iterable<string>} [options.skip] layer ids the caller counts itself:
 *   a token layer (its tokens, spans, relations and links), a span layer (its
 *   spans and relations) or a relation layer. The cascade still runs through
 *   them, they are only left out of the count.
 * @param {object[]} [options.vocabLinks] the links to read, when the caller
 *   holds a fresher list than the layers' own `vocabs`
 * @param {boolean|function} [options.content] also count each token that goes
 *   and holds content of its own (true: metadata beyond provenance, or a
 *   predicate on the token)
 * @returns {{annotations: number, spans: number, relations: number,
 *   content: number, links: number, byLayer: Map<string, number>}}
 *   `annotations` is spans plus relations plus content. `byLayer` counts the
 *   tokens, spans and relations that go, by the id of the layer they are on,
 *   and the links by vocabulary id. The given tokens are counted under their
 *   own layer unless `under` is set.
 */
export const countDeleteLoss = (tokenLayers, tokenIds, options = {}) => {
  const { under = false, skip, vocabLinks, content = false } = options;
  const result = EMPTY();
  const layers = tokenLayers || [];
  const ids = new Set(tokenIds || []);
  if (!ids.size || !layers.length) return result;
  const skipped = skipper(skip);
  const hasContent =
    typeof content === 'function' ? content : content ? hasOwnContent : () => false;
  const childrenOf = childrenByParent(layers);

  // Every token that goes, with the layer it is on.
  const dying = new Map(); // token id -> token layer id
  for (const tl of layers) {
    const given = (tl.tokens || []).filter((t) => ids.has(t.id));
    if (!given.length) continue;
    if (!under) given.forEach((t) => dying.set(t.id, tl.id));
    for (const nested of nestedUnder(childrenOf, tl.id)) {
      for (const t of nested.tokens || []) {
        if (given.some((g) => within(g, t))) dying.set(t.id, nested.id);
      }
    }
  }
  if (!dying.size) return result;

  for (const tl of layers) {
    for (const t of tl.tokens || []) {
      if (!dying.has(t.id) || skipped(tl.id)) continue;
      bump(result.byLayer, tl.id);
      if (hasContent(t)) result.content += 1;
    }
  }

  // Spans on a token that goes, and the spans left with none.
  const emptied = new Set();
  for (const tl of layers) {
    for (const sl of tl.spanLayers || []) {
      for (const s of sl.spans || []) {
        const toks = Array.isArray(s.tokens) ? s.tokens : [];
        if (!toks.some((t) => dying.has(t))) continue;
        if (toks.every((t) => dying.has(t))) emptied.add(s.id);
        if (skipped(tl.id, sl.id)) continue;
        result.spans += 1;
        bump(result.byLayer, sl.id);
      }
    }
  }
  for (const tl of layers) {
    for (const sl of tl.spanLayers || []) {
      for (const rl of sl.relationLayers || []) {
        if (skipped(tl.id, sl.id, rl.id)) continue;
        for (const r of rl.relations || []) {
          if (!emptied.has(r.source) && !emptied.has(r.target)) continue;
          result.relations += 1;
          bump(result.byLayer, rl.id);
        }
      }
    }
  }

  // Vocabulary links on a token that goes.
  const linkSources = vocabLinks
    ? [{ vocabId: null, links: vocabLinks }]
    : layers
        .filter((tl) => !skipped(tl.id))
        .flatMap((tl) =>
          (tl.vocabs || []).map((v) => ({ vocabId: v.id, links: v.vocabLinks || [] })),
        );
  const seen = new Set();
  for (const { vocabId, links } of linkSources) {
    for (const link of links) {
      if (seen.has(link.id ?? link)) continue;
      const toks = Array.isArray(link.tokens) ? link.tokens : [];
      if (!toks.some((t) => dying.has(t))) continue;
      seen.add(link.id ?? link);
      result.links += 1;
      if (vocabId) bump(result.byLayer, vocabId);
    }
  }

  result.annotations = result.spans + result.relations + result.content;
  return result;
};

/**
 * Count the relations splitting `tokenId` at `position` deletes: those on a
 * relation layer that declares `same-ancestor` over the token's layer (under
 * any app's namespace) whose two ends fall in different halves. An end
 * outside the token is left alone, as an end in no token of that layer is.
 *
 * @param {object[]} tokenLayers a text layer's token layers, every app's
 * @param {string} tokenId the token split
 * @param {number} position where it is split
 * @param {object} [options]
 * @param {Iterable<string>} [options.skip] layer ids the caller counts itself
 * @returns the same shape as countDeleteLoss
 */
export const countSplitLoss = (tokenLayers, tokenId, position, options = {}) => {
  const result = EMPTY();
  const layers = tokenLayers || [];
  const skipped = skipper(options.skip);
  const owner = layers.find((tl) => (tl.tokens || []).some((t) => t.id === tokenId));
  const token = owner?.tokens.find((t) => t.id === tokenId);
  if (!token || !(token.begin < position && position < token.end)) return result;

  const tokenById = new Map();
  for (const tl of layers) for (const t of tl.tokens || []) tokenById.set(t.id, t);
  // Which half of the split token a span lies in: -1 left, 1 right, 0 neither
  // (outside it, or across the split point).
  const side = (span) => {
    const toks = (span?.tokens || []).map((id) => tokenById.get(id)).filter(Boolean);
    if (!toks.length || !toks.every((t) => within(token, t))) return 0;
    if (toks.every((t) => t.end <= position)) return -1;
    if (toks.every((t) => t.begin >= position)) return 1;
    return 0;
  };
  const declares = (rl) =>
    Object.values(rl.constraints || {}).some(
      (list) =>
        Array.isArray(list) &&
        list.some(
          (c) => c?.type === 'same-ancestor' && (c.tokenLayer ?? c['token-layer']) === owner.id,
        ),
    );

  for (const tl of layers) {
    for (const sl of tl.spanLayers || []) {
      const spanById = new Map((sl.spans || []).map((s) => [s.id, s]));
      for (const rl of sl.relationLayers || []) {
        if (skipped(tl.id, sl.id, rl.id) || !declares(rl)) continue;
        for (const r of rl.relations || []) {
          const a = side(spanById.get(r.source));
          const b = side(spanById.get(r.target));
          if (a && b && a !== b) {
            result.relations += 1;
            bump(result.byLayer, rl.id);
          }
        }
      }
    }
  }
  result.annotations = result.relations;
  return result;
};

/**
 * "3 annotations and 2 vocabulary links", the counts a question about a
 * delete names, or '' when there are none.
 */
export const lossPhrase = ({ annotations = 0, links = 0 } = {}) => {
  const parts = [];
  if (annotations) parts.push(`${annotations} ${annotations === 1 ? 'annotation' : 'annotations'}`);
  if (links) parts.push(`${links} ${links === 1 ? 'vocabulary link' : 'vocabulary links'}`);
  return parts.join(' and ');
};
