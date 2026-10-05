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
//   - every span whose tokens all go (one that keeps some of its tokens is
//     only cut down to them, and counted apart, as shortened),
//   - every relation with an end on a span left with no tokens,
//   - every vocabulary link whose tokens all go (shortened, like a span, when
//     it keeps some of them).
// Deleting a stretch of text deletes every token of every layer that lies
// within it, and so all of the above for each (countTextDeleteLoss).
// Splitting a token deletes every relation on a layer that declares
// `same-ancestor` over the split token's layer and whose ends then lie in
// different halves, an end lying where the smallest begin of its span's
// tokens is (core's place).
//
// No bare imports: plaid-ud's node suite imports this file by path.

import { PROVENANCE_KEYS } from '../../../plaid-client-js/src/provenance.js';

const EMPTY = () => ({
  annotations: 0,
  spans: 0,
  relations: 0,
  content: 0,
  links: 0,
  // Spans and links that keep some of their tokens: cut down, not deleted.
  shortened: { annotations: 0, links: 0 },
  // The relations that go, by id, so a write's own patch can drop them.
  relationIds: [],
  byLayer: new Map(),
});

/** Whether a count holds anything a question should name. */
export const hasLoss = (loss) =>
  Boolean(
    loss &&
      (loss.annotations || loss.links || loss.shortened?.annotations || loss.shortened?.links),
  );

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

// Every token deleting `ids` takes, with the layer it is on: the tokens
// themselves (unless `under`) and every token of a nested layer within one.
const dyingTokens = (layers, ids, under = false) => {
  const childrenOf = childrenByParent(layers);
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
  return dying;
};

// Whether a relation layer declares `same-ancestor` over `layerId`, under any
// app's namespace.
const keepsWithin = (rl, layerId) =>
  Object.values(rl.constraints || {}).some(
    (list) =>
      Array.isArray(list) &&
      list.some(
        (c) => c?.type === 'same-ancestor' && (c.tokenLayer ?? c['token-layer']) === layerId,
      ),
  );

// Where core places a span: the smallest begin of its tokens, or null.
const placer = (layers) => {
  const beginOf = new Map();
  for (const tl of layers) for (const t of tl.tokens || []) beginOf.set(t.id, t.begin);
  return (span) => {
    const begins = (span?.tokens || []).map((id) => beginOf.get(id)).filter(Number.isFinite);
    return begins.length ? Math.min(...begins) : null;
  };
};

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
 *   predicate on the token and its layer id)
 * @returns {{annotations: number, spans: number, relations: number,
 *   content: number, links: number, byLayer: Map<string, number>}}
 *   `annotations` is spans plus relations plus content, of what is deleted.
 *   `shortened` counts apart the spans and links only cut down. `byLayer` counts the
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
  const dying = dyingTokens(layers, ids, under);
  if (!dying.size) return result;

  for (const tl of layers) {
    for (const t of tl.tokens || []) {
      if (!dying.has(t.id) || skipped(tl.id)) continue;
      bump(result.byLayer, tl.id);
      if (hasContent(t, tl.id)) result.content += 1;
    }
  }

  // Spans on a token that goes, and the spans left with none.
  const emptied = new Set();
  for (const tl of layers) {
    for (const sl of tl.spanLayers || []) {
      for (const s of sl.spans || []) {
        const toks = Array.isArray(s.tokens) ? s.tokens : [];
        if (!toks.some((t) => dying.has(t))) continue;
        const gone = toks.every((t) => dying.has(t));
        if (gone) emptied.add(s.id);
        if (skipped(tl.id, sl.id)) continue;
        if (!gone) {
          result.shortened.annotations += 1;
          continue;
        }
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
          result.relationIds.push(r.id);
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
      if (!toks.every((t) => dying.has(t))) {
        result.shortened.links += 1;
        continue;
      }
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
 * any app's namespace) whose two ends fall in different halves. An end lies
 * at the smallest begin of its span's tokens, as core places it. A relation
 * with an end outside the token is left alone: it crosses already, or the
 * end is in no token of that layer, which crosses nothing.
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
  // Which half of the split token a span falls in, as core places it: by the
  // smallest begin of its tokens. -1 left, 1 right, 0 outside the token.
  const side = (span) => {
    const begins = (span?.tokens || [])
      .map((id) => tokenById.get(id)?.begin)
      .filter((b) => typeof b === 'number');
    if (!begins.length) return 0;
    const place = Math.min(...begins);
    if (place < token.begin || place >= token.end) return 0;
    return place < position ? -1 : 1;
  };
  const declares = (rl) => keepsWithin(rl, owner.id);

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
            result.relationIds.push(r.id);
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
 * Count the relations a new partition of the layer `layerId` deletes: those
 * on a relation layer that declares `same-ancestor` over it whose ends lie in
 * one token of the layer today, or in none, and in two of `ranges` after. An
 * end lies at the smallest begin of its span's tokens, and an end in no range
 * crosses nothing, as in core.
 *
 * `ranges` are the planned tokens as [begin, end) pairs. When they are not
 * known in advance (a service decides them), pass 'any': every two ends at
 * different places count, which is the most the new breaks can take.
 *
 * @param {object[]} tokenLayers a text layer's token layers, every app's
 * @param {string} layerId the layer partitioned anew
 * @param {Array<[number, number]>|'any'} ranges its planned tokens
 * @param {object} [options]
 * @param {Iterable<string>} [options.skip] layer ids the caller counts itself
 * @param {Iterable<string>} [options.deleting] tokens the same run deletes,
 *   whose relations countDeleteLoss counts already: those are left out here
 * @returns the same shape as countDeleteLoss
 */
export const countPartitionLoss = (tokenLayers, layerId, ranges, options = {}) => {
  const result = EMPTY();
  const layers = tokenLayers || [];
  const skipped = skipper(options.skip);
  const current = layers.find((tl) => tl.id === layerId)?.tokens || [];
  const dying = dyingTokens(layers, new Set(options.deleting || []));
  const placeOf = placer(layers);
  const holder = (tokens) => (p) => {
    if (p == null) return null;
    const i = tokens.findIndex(([b, e]) => b <= p && p < e);
    return i === -1 ? null : i;
  };
  const now = holder(current.map((t) => [t.begin, t.end]));
  const after = ranges === 'any' ? (p) => p : holder(ranges || []);
  const crosses = (anc, a, b) => {
    const x = anc(a);
    const y = anc(b);
    return x != null && y != null && x !== y;
  };

  for (const tl of layers) {
    for (const sl of tl.spanLayers || []) {
      const spanById = new Map((sl.spans || []).map((sp) => [sp.id, sp]));
      const gone = (sp) => (sp?.tokens || []).length > 0 && sp.tokens.every((t) => dying.has(t));
      for (const rl of sl.relationLayers || []) {
        if (skipped(tl.id, sl.id, rl.id) || !keepsWithin(rl, layerId)) continue;
        for (const r of rl.relations || []) {
          const src = spanById.get(r.source);
          const tgt = spanById.get(r.target);
          if (gone(src) || gone(tgt)) continue;
          const a = placeOf(src);
          const b = placeOf(tgt);
          if (crosses(now, a, b) || !crosses(after, a, b)) continue;
          result.relations += 1;
          result.relationIds.push(r.id);
          bump(result.byLayer, rl.id);
        }
      }
    }
  }
  result.annotations = result.relations;
  return result;
};

/**
 * Count what deleting stretches of the text takes. Core deletes every token,
 * of every layer, that lies within a deleted stretch (a zero-width one only
 * strictly inside it), and the rest follows as for a token delete. Tokens
 * that only overlap a stretch are cut down and stay.
 *
 * @param {object[]} tokenLayers a text layer's token layers, every app's
 * @param {Array<[number, number]>} ranges the deleted stretches, [begin, end)
 *   in the text as it is before the delete
 * @param {object} [options] as countDeleteLoss, plus `except`: token ids the
 *   caller deletes on purpose and does not count (a segment deleted with its
 *   text)
 * @returns the same shape as countDeleteLoss
 */
export const countTextDeleteLoss = (tokenLayers, ranges, options = {}) => {
  const { except, ...rest } = options;
  const skipIds = new Set(except || []);
  const ids = [];
  for (const tl of tokenLayers || []) {
    for (const t of tl.tokens || []) {
      if (skipIds.has(t.id)) continue;
      const inside = (ranges || []).some(([b, e]) =>
        t.begin === t.end ? b < t.begin && t.end < e : b <= t.begin && t.end <= e,
      );
      if (inside) ids.push(t.id);
    }
  }
  return countDeleteLoss(tokenLayers, ids, rest);
};

/**
 * Drop the relations `ids` from a document's token layers, in place: what a
 * write's own optimistic patch does with the relations a layer rule deletes in
 * that write's transaction (the ids a split or partition count found).
 */
export const dropRelations = (tokenLayers, ids) => {
  const gone = new Set(ids || []);
  if (!gone.size) return;
  for (const tl of tokenLayers || []) {
    for (const sl of tl.spanLayers || []) {
      for (const rl of sl.relationLayers || []) {
        if (Array.isArray(rl.relations) && rl.relations.some((r) => gone.has(r.id))) {
          rl.relations = rl.relations.filter((r) => !gone.has(r.id));
        }
      }
    }
  }
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
