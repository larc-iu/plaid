// What another app's edits to the shared sentences and words do to a UMR
// document, as core does them, over a raw document in memory, and an open in
// UMR that runs the real reconcile against a client writing into that same
// raw document. For tests of what UMR's data survives. Not a test file
// itself, so the runner does not pick it up.
//
// Core, as modelled (plaid-core sql/token.clj and constraints/layer.clj):
//   - a sentence merge grows the left token, deletes the right one with its
//     metadata, and moves the spans on it to the left
//   - a split keeps the token, its id and metadata, on the left and makes a
//     new right token with only the `preserveOnSplit` keys; a token of a
//     layer nested under it that straddles the split is split too, and no
//     other layer's token changes (a node over a word split in two stands
//     over both halves)
//   - deleting a token deletes the tokens nested inside it, a span left with
//     no token, and every relation on a span that goes
//   - after each of these, a UMR relation whose two ends begin in different
//     sentences is deleted (the `same-ancestor` rule)
//   - "Clear sentences" merges every sentence into the first
//   - a respell strictly inside a word grows or shrinks every token holding
//     it and moves every token after it
import { applyMetadataOps } from '@larc-iu/plaid-client';
import { UmrDocument } from '../src/domain/UmrDocument.js';

const tokenLayers = (raw) => raw.textLayers[0].tokenLayers;
const byRole = (raw, r) => tokenLayers(raw).find((l) => l.config?.plaid?.role === r);
const byBegin = (a, b) => a.begin - b.begin || a.end - b.end;

export const layersOf = (raw) => {
  const nodes = tokenLayers(raw).find((l) => l.config?.umr?.nodes);
  const concepts = nodes.spanLayers.find((s) => s.config?.umr?.concepts);
  return {
    sentence: byRole(raw, 'sentence'),
    word: byRole(raw, 'word'),
    nodes,
    concepts,
    relations: concepts.relationLayers.find((x) => x.config?.umr?.relations),
    triples: concepts.relationLayers.find((x) => x.config?.umr?.documentGraph),
  };
};

export const sentencesOf = (raw) => [...layersOf(raw).sentence.tokens].sort(byBegin);
export const wordsOf = (raw) => [...layersOf(raw).word.tokens].sort(byBegin);

let seq = 0;
const newId = (prefix) => `${prefix}-${++seq}`;

const childrenOf = (raw, layer) => {
  const out = [];
  const walk = (id) =>
    tokenLayers(raw)
      .filter((l) => l.parentTokenLayer === id)
      .forEach((l) => {
        out.push(l);
        walk(l.id);
      });
  walk(layer.id);
  return out;
};

/** Delete tokens as core does, with what is nested in them and what hangs on them. */
export function deleteTokens(raw, ids) {
  const gone = new Set(ids);
  tokenLayers(raw).forEach((l) => {
    const below = childrenOf(raw, l);
    l.tokens
      .filter((t) => gone.has(t.id))
      .forEach((t) =>
        below.forEach((d) =>
          d.tokens.forEach((c) => {
            if (c.begin >= t.begin && c.end <= t.end) gone.add(c.id);
          }),
        ),
      );
  });
  const goneSpans = new Set();
  tokenLayers(raw).forEach((l) => {
    l.tokens = l.tokens.filter((t) => !gone.has(t.id));
    (l.spanLayers || []).forEach((sl) => {
      sl.spans.forEach((s) => {
        s.tokens = s.tokens.filter((t) => !gone.has(t));
        if (!s.tokens.length) goneSpans.add(s.id);
      });
      sl.spans = sl.spans.filter((s) => !goneSpans.has(s.id));
    });
  });
  tokenLayers(raw).forEach((l) =>
    (l.spanLayers || []).forEach((sl) =>
      (sl.relationLayers || []).forEach((rl) => {
        rl.relations = rl.relations.filter(
          (r) => !goneSpans.has(r.source) && !goneSpans.has(r.target),
        );
      }),
    ),
  );
}

// The `same-ancestor` rule UMR declares on its relation layer: a relation
// whose ends begin in different sentences (or in none) is deleted.
function sameAncestor(raw) {
  const L = layersOf(raw);
  const tokens = new Map(L.nodes.tokens.map((t) => [t.id, t]));
  const sentences = sentencesOf(raw);
  const home = (p) => sentences.find((s) => s.begin <= p && p < s.end)?.id ?? null;
  const place = (id) => {
    const span = L.concepts.spans.find((s) => s.id === id);
    return Math.min(...span.tokens.map((t) => tokens.get(t)?.begin ?? Infinity));
  };
  L.relations.relations = L.relations.relations.filter((r) => {
    const a = home(place(r.source));
    return a != null && a === home(place(r.target));
  });
}

/** igt "Merge with above" on the sentence at 1-based `index` (2 or more). */
export function mergeSentence(raw, index) {
  const L = layersOf(raw);
  const sentences = sentencesOf(raw);
  const right = sentences[index - 1];
  const left = sentences[index - 2];
  left.end = right.end;
  L.sentence.spanLayers.forEach((sl) =>
    sl.spans.forEach((sp) => (sp.tokens = sp.tokens.map((t) => (t === right.id ? left.id : t)))),
  );
  L.sentence.tokens = L.sentence.tokens.filter((t) => t.id !== right.id);
  sameAncestor(raw);
}

/** igt "Clear sentences": every sentence merged into the first. */
export function clearSentences(raw) {
  while (sentencesOf(raw).length > 1) mergeSentence(raw, 2);
}

/** Split `tokenId` of `layer` at `pos`, as core's split does. */
export function splitToken(raw, layer, tokenId, pos) {
  const t = layer.tokens.find((x) => x.id === tokenId);
  const keep = layer.config?.plaid?.preserveOnSplit || [];
  const { end } = t;
  const right = { id: newId('split'), begin: pos, end };
  const inherited = Object.fromEntries(
    Object.entries(t.metadata || {}).filter(([k]) => keep.includes(k)),
  );
  if (Object.keys(inherited).length) right.metadata = inherited;
  t.end = pos;
  layer.tokens.push(right);
  const below = childrenOf(raw, layer);
  below.forEach((d) =>
    [...d.tokens].forEach((c) => {
      if (c.begin < pos && pos < c.end) {
        d.tokens.push({ id: newId('split'), begin: pos, end: c.end });
        c.end = pos;
      }
    }),
  );
  sameAncestor(raw);
  return right.id;
}

/** A sentence boundary put at `pos`, between two words. False when there is none to put. */
export function splitSentenceAt(raw, pos) {
  const s = sentencesOf(raw).find((x) => x.begin <= pos && pos < x.end);
  if (!s || s.begin === pos) return false;
  if (wordsOf(raw).some((w) => w.begin < pos && pos < w.end)) return false;
  splitToken(raw, layersOf(raw).sentence, s.id, pos);
  return true;
}

/** igt Tokenize: a word deleted, its text left. */
export function deleteWord(raw, wordId) {
  deleteTokens(raw, [wordId]);
  sameAncestor(raw);
}

/** igt Tokenize: a word split in two at `pos`. */
export function splitWord(raw, wordId, pos) {
  return splitToken(raw, layersOf(raw).word, wordId, pos);
}

/** igt Tokenize: two neighbouring words of one sentence joined. */
export function mergeWords(raw, leftId, rightId) {
  const L = layersOf(raw);
  const a = L.word.tokens.find((t) => t.id === leftId);
  const b = L.word.tokens.find((t) => t.id === rightId);
  a.end = Math.max(a.end, b.end);
  L.word.tokens = L.word.tokens.filter((t) => t.id !== b.id);
  sameAncestor(raw);
}

/**
 * The letters at [from, to), strictly inside one word, replaced by `insert`:
 * every token holding the edit grows or shrinks, every one after it moves.
 * False, with nothing changed, when a token begins or ends inside the edit.
 */
export function respell(raw, from, to, insert) {
  const all = tokenLayers(raw).flatMap((l) => l.tokens);
  const after = (t) => t.begin >= to && t.begin > from;
  const holds = (t) => t.end >= to && t.begin <= from;
  if (all.some((t) => !after(t) && !holds(t) && t.end > from)) return false;
  const text = raw.textLayers[0].text;
  const body = [...text.body];
  const added = [...insert];
  body.splice(from, to - from, ...added);
  text.body = body.join('');
  const d = added.length - (to - from);
  all.forEach((t) => {
    if (after(t)) {
      t.begin += d;
      t.end += d;
    } else if (holds(t)) t.end += d;
  });
  return true;
}

// A client that writes what reconcile sends into `raw`, as core would.
function memoryClient(raw) {
  const all = () => tokenLayers(raw).flatMap((l) => l.tokens);
  const spans = () => tokenLayers(raw).flatMap((l) => (l.spanLayers || []).flatMap((s) => s.spans));
  const relations = () =>
    tokenLayers(raw).flatMap((l) =>
      (l.spanLayers || []).flatMap((s) => (s.relationLayers || []).flatMap((r) => r.relations)),
    );
  const patch = (list, id, ops) => {
    const x = list.find((y) => y.id === id);
    if (!x) throw Object.assign(new Error(`no ${id}`), { status: 404 });
    x.metadata = applyMetadataOps(x.metadata || {}, ops);
  };
  const api = {
    tokens: {
      bulkDelete: async (ids) => deleteTokens(raw, ids),
      bulkCreate: async (ops) => {
        ops.forEach((op) => {
          const layer = tokenLayers(raw).find((l) => l.id === op.tokenLayerId);
          const token = { id: op.id ?? newId('made'), begin: op.begin, end: op.end };
          if (op.metadata) token.metadata = structuredClone(op.metadata);
          layer.tokens.push(token);
        });
        return { ids: ops.map((op) => op.id) };
      },
      bulkUpdate: async (entries) => entries.forEach((e) => patch(all(), e.id, e.metadata)),
      update: async (id, begin, end) => {
        const t = all().find((x) => x.id === id);
        [t.begin, t.end] = [begin, end];
      },
      patchMetadata: async (id, ops) => patch(all(), id, ops),
    },
    spans: {
      patchMetadata: async (id, ops) => patch(spans(), id, ops),
      setTokens: async (id, tokens) => {
        spans().find((s) => s.id === id).tokens = [...tokens];
      },
    },
    relations: {
      patchMetadata: async (id, ops) => patch(relations(), id, ops),
    },
    documents: {
      checkLock: async () => null,
      auditPage: async () => ({ entries: [], nextCursor: null }),
    },
    serverNow: () => new Date(),
    withOperation: async (label, fn) => fn(() => {}),
    batched: async (fn) => {
      const queue = [];
      const proxy = (group) =>
        new Proxy(
          {},
          {
            get:
              (_, method) =>
              (...args) =>
                queue.push(() => api[group][method](...args)),
          },
        );
      await fn({ tokens: proxy('tokens'), spans: proxy('spans'), relations: proxy('relations') });
      const out = [];
      for (const op of queue) out.push({ body: await op() });
      return out;
    },
  };
  return api;
}

/**
 * Open the document in UMR: the real reconcile, its writes landing in `raw`.
 * Resolves to its tally.
 */
export async function openInUmr(raw) {
  const doc = new UmrDocument({ raw: structuredClone(raw), client: memoryClient(raw) });
  doc._reload = async () => doc._swapRaw(structuredClone(raw));
  const result = await doc._reconcile();
  if (result.error) throw result.error;
  return result;
}

/** Whether an open writes nothing. */
export const openWritesNothing = async (raw) => {
  const before = JSON.stringify(raw);
  await openInUmr(raw);
  return JSON.stringify(raw) === before;
};
