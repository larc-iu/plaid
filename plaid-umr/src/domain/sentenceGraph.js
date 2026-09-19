// The one reading of a UMR document's layers: from the raw document's tokens,
// spans and relations to per-sentence graphs, and from those graphs to the
// sentence objects the .umr serializer takes. What the canvas draws and what
// the exporter writes come from here, so they cannot disagree.
//
// Storage (see docs/umr/DESIGN.md):
//   node   = a span in the concept layer, value = concept, tokens = the anchor
//            pieces in the UMR node layer (zero-width when unaligned),
//            metadata.umr = { var, attrs: [{ rel, value, order }], constant?,
//            root? } where `root` marks the sentence's root
//   edge   = a relation in the relation layer, value = role,
//            metadata.umr = { order }
//   triple = a relation in the document-graph layer, value = the relation,
//            metadata.umr = { group, sentences? } where `group` is temporal,
//            modal or coref and `sentences` lists, for a triple between two
//            constants (which belongs to no sentence by itself), the
//            sentences whose blocks write it
//   sentence token metadata.umr = { snt, text?, ilg, meta, rawGraph?,
//            rawAlignment? } where the raw pair holds a graph the parser
//            could not read, kept as text so nothing is lost
//
// By its real path rather than through `@ui`: the node suite has no alias.
import { cpSlice } from '@larc-iu/plaid-client';
import { UMR_NAMESPACE } from '../utils/umrLayerUtils.js';
import { treeEdges } from './format/penman.js';

const umrMeta = (entity) => entity?.metadata?.[UMR_NAMESPACE] || {};

// Half-open containment of a zero-width or positive-width piece in a range.
const beginsIn = (piece, range) => piece.begin >= range.begin && piece.begin < range.end;

// Positive overlap between two ranges.
const overlaps = (a, b) => a.begin < b.end && b.begin < a.end;

const byBegin = (a, b) => a.begin - b.begin || a.end - b.end;

// A raw span's anchor pieces, as token objects, in text order.
const anchorPieces = (span, tokensById) =>
  (span.tokens || [])
    .map((id) => tokensById.get(id))
    .filter(Boolean)
    .sort(byBegin);

/**
 * Every sentence of the document with its words, gloss lines, nodes, edges
 * and document-level triples. Pure: takes the layer info of a raw document.
 *
 * @param {object} layerInfo from getUmrLayerInfo(raw)
 * @returns {{ sentences: Array, constants: Array, nodesById: Map }}
 */
export function buildDocumentGraph(layerInfo, { ilg = null } = {}) {
  const body = layerInfo.textLayer?.text?.body ?? '';
  const sentenceTokens = [...(layerInfo.sentenceTokenLayer?.tokens || [])].sort(byBegin);
  const wordTokens = [...(layerInfo.wordTokenLayer?.tokens || [])].sort(byBegin);
  const morphemeTokens = [...(layerInfo.morphemeTokenLayer?.tokens || [])].sort(byBegin);
  const nodeTokens = layerInfo.nodeTokenLayer?.tokens || [];
  const nodeTokensById = new Map(nodeTokens.map((t) => [t.id, t]));
  const spans = layerInfo.conceptLayer?.spans || [];
  const relations = layerInfo.relationLayer?.relations || [];
  const docRelations = layerInfo.documentGraphLayer?.relations || [];

  // Sentences and their words. A word belongs to the sentence its begin
  // falls in.
  const sentences = sentenceTokens.map((token, i) => {
    const meta = umrMeta(token);
    return {
      index: i + 1,
      tokenId: token.id,
      begin: token.begin,
      end: token.end,
      text: meta.text || cpSlice(body, token.begin, token.end).replace(/\n+$/, ''),
      words: [],
      morphemes: [],
      // What an import stored, and (once the words are known) the lines the
      // mapping resolves them and the layers into.
      storedIlg: meta.ilg || [],
      ilg: [],
      meta: meta.meta || [],
      snt: meta.snt || null,
      rawGraph: meta.rawGraph || null,
      rawAlignment: meta.rawAlignment || null,
      nodes: [],
      edges: [],
      triples: [],
    };
  });
  const sentenceOf = (piece) => sentences.find((s) => beginsIn(piece, s));

  wordTokens.forEach((token) => {
    const s = sentenceOf(token);
    if (!s) return;
    s.words.push({
      id: token.id,
      index: s.words.length + 1,
      begin: token.begin,
      end: token.end,
      text: cpSlice(body, token.begin, token.end),
      metadata: token.metadata || null,
    });
  });
  morphemeTokens.forEach((token) => {
    const s = sentenceOf(token);
    if (!s) return;
    s.morphemes.push({
      id: token.id,
      begin: token.begin,
      end: token.end,
      text: cpSlice(body, token.begin, token.end),
      precedence: token.precedence ?? null,
    });
  });

  // Nodes. A constant belongs to no sentence.
  const nodesById = new Map();
  const constants = [];
  spans.forEach((span) => {
    const meta = umrMeta(span);
    const pieces = anchorPieces(span, nodeTokensById);
    const node = {
      id: span.id,
      var: meta.var || null,
      concept: span.value ?? '',
      attrs: [...(meta.attrs || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      constant: meta.constant === true,
      root: meta.root === true,
      pieces,
      aligned: pieces.some((p) => p.end > p.begin),
      metadata: span.metadata || null,
      sentence: null,
      chain: null,
      out: [],
      in: [],
      docOut: [],
      docIn: [],
    };
    nodesById.set(span.id, node);
    if (node.constant) {
      constants.push(node);
      return;
    }
    const s = pieces.length ? sentenceOf(pieces[0]) : null;
    if (s) {
      node.sentence = s.index;
      s.nodes.push(node);
    }
  });

  // Edges, attached to the head's sentence.
  relations.forEach((rel) => {
    const source = nodesById.get(rel.source);
    const target = nodesById.get(rel.target);
    if (!source || !target) return;
    const edge = {
      id: rel.id,
      source: rel.source,
      target: rel.target,
      role: rel.value ?? '',
      order: umrMeta(rel).order ?? 0,
      metadata: rel.metadata || null,
    };
    source.out.push(edge);
    target.in.push(edge);
    const s = source.sentence != null ? sentences[source.sentence - 1] : null;
    if (s) s.edges.push(edge);
  });

  // Document-level triples, attached to the LATER of the two sentences
  // involved: the one whose block the file writes them in. A triple between
  // two constants belongs to the sentences its metadata lists.
  docRelations.forEach((rel) => {
    const source = nodesById.get(rel.source);
    const target = nodesById.get(rel.target);
    if (!source || !target) return;
    const meta = umrMeta(rel);
    const triple = {
      id: rel.id,
      source: rel.source,
      target: rel.target,
      rel: rel.value ?? '',
      group: meta.group || groupOf(rel.value ?? ''),
      metadata: rel.metadata || null,
    };
    source.docOut.push(triple);
    target.docIn.push(triple);
    const later = Math.max(source.sentence ?? 0, target.sentence ?? 0);
    if (later > 0) {
      sentences[later - 1].triples.push(triple);
    } else if (source.constant && target.constant) {
      (meta.sentences || []).forEach((n) => sentences[n - 1]?.triples.push(triple));
    }
  });

  // Anchors as 1-based word indices, per piece, once the words are known.
  sentences.forEach((s) => {
    s.nodes.forEach((node) => {
      node.alignment = alignmentOf(node, s.words);
      node.wordIds = node.pieces
        .flatMap((p) => s.words.filter((w) => overlaps(p, w)).map((w) => w.id))
        .filter((id, i, arr) => arr.indexOf(id) === i);
    });
    s.nodes.sort(nodeOrder);
    s.edges.sort((a, b) => a.order - b.order);
    s.roots = rootsOf(s, nodesById);
    s.ilg = ilg ? ilg(s, layerInfo) : storedLines(s);
  });

  const chains = corefChains(docRelations, nodesById);

  return { sentences, constants, nodesById, chains };
}

// The coreference relations, whichever way they point, join nodes into chains.
export const COREF_RELATIONS = new Set([':same-entity', ':same-event', ':subset-of', ':subset']);

// Chains as connected components over the coreference triples, numbered in
// order of first mention, and each node told its chain.
function corefChains(docRelations, nodesById) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  docRelations.forEach((rel) => {
    if (!COREF_RELATIONS.has(rel.value)) return;
    if (nodesById.has(rel.source) && nodesById.has(rel.target)) union(rel.source, rel.target);
  });
  const members = new Map();
  parent.forEach((_, id) => {
    const root = find(id);
    if (!members.has(root)) members.set(root, []);
    members.get(root).push(id);
  });
  const position = (id) => {
    const n = nodesById.get(id);
    return [n.sentence ?? 0, n.pieces[0]?.begin ?? 0];
  };
  const chains = [...members.values()]
    .map((ids) =>
      ids.sort((a, b) => {
        const [sa, ba] = position(a);
        const [sb, bb] = position(b);
        return sa - sb || ba - bb;
      }),
    )
    .sort((a, b) => {
      const [sa, ba] = position(a[0]);
      const [sb, bb] = position(b[0]);
      return sa - sb || ba - bb;
    })
    .map((ids, i) => ({ index: i, nodes: ids }));
  chains.forEach((chain) => chain.nodes.forEach((id) => (nodesById.get(id).chain = chain.index)));
  return chains;
}

// Without a mapping, the stored lines as they were, grouped under the words
// when there is one item per word.
const storedLines = (s) =>
  (s.storedIlg || [])
    .filter((line) => line.key !== 'index' && line.key !== 'words')
    .map((line) => ({
      ...line,
      perWord: line.items.length === s.words.length ? line.items.map((x) => [x]) : null,
    }));

// The roles a graph may cycle through (the validator allows no others): an
// edge with one of these into a node does not make it a child, so the root
// of `(s / say-01 :ARG1 (b / believe-01 :quote s))` is still say-01.
export const CYCLE_ROLES = new Set([':quote', ':modal-predicate']);

// The sentence's roots. A node marked as the root (the file's own, kept at
// import) is one whatever reaches it, since a graph may cycle back into its
// root through more than :quote in the released data. Otherwise: nodes no
// in-sentence edge reaches, cycle roles aside. A graph with neither still
// needs a root to draw and write from, so the node that reaches the most
// others stands in, ties to the first in anchor order.
function rootsOf(sentence, nodesById) {
  const inSentence = (id) => nodesById.get(id)?.sentence === sentence.index;
  const marked = sentence.nodes.filter((n) => n.root);
  const derived = sentence.nodes.filter(
    (n) => !n.root && !n.in.some((e) => inSentence(e.source) && !CYCLE_ROLES.has(e.role)),
  );
  // The marked root first, then any fragment: a node nothing reaches while
  // the graph has its root elsewhere.
  const roots = [...marked, ...derived];
  if (roots.length || !sentence.nodes.length) return roots;
  const reach = (start) => {
    const seen = new Set([start.id]);
    const stack = [start];
    while (stack.length) {
      const n = stack.pop();
      n.out.forEach((e) => {
        if (inSentence(e.target) && !seen.has(e.target)) {
          seen.add(e.target);
          stack.push(nodesById.get(e.target));
        }
      });
    }
    return seen.size;
  };
  let best = sentence.nodes[0];
  let bestReach = -1;
  sentence.nodes.forEach((n) => {
    const r = reach(n);
    if (r > bestReach) {
      best = n;
      bestReach = r;
    }
  });
  return [best];
}

// Nodes in a sentence read by anchor position, then by variable, so a list
// of them is stable across reloads.
const nodeOrder = (a, b) => {
  const ab = a.pieces[0]?.begin ?? 0;
  const bb = b.pieces[0]?.begin ?? 0;
  if (ab !== bb) return ab - bb;
  return String(a.var).localeCompare(String(b.var));
};

// The 1-based inclusive word ranges a node's pieces cover. A zero-width piece
// covers nothing, so an unaligned node gives [].
export function alignmentOf(node, words) {
  const ranges = [];
  node.pieces.forEach((piece) => {
    const covered = words.filter((w) => overlaps(piece, w));
    if (!covered.length) return;
    ranges.push([covered[0].index, covered[covered.length - 1].index]);
  });
  return ranges;
}

// Which document-level group a relation belongs to, for a relation written
// by a path that did not record it. `:contains` is in two groups, which is
// why the import records the group rather than leaving it to this.
export const groupOf = (rel) => {
  if (/^:(same-entity|same-event|subset-of|subset)$/.test(rel)) return 'coref';
  if (/^:(before|after|contained|overlap|depends-on|contains)$/.test(rel)) return 'temporal';
  return 'modal';
};

/**
 * The sentence objects `serializeUmrFile` takes, from a built document graph.
 * Child order under a node follows the stored `order` across attributes and
 * edges, and a re-entrant node is expanded at the first edge reached from the
 * root (the same rule the canvas uses for tree edges). Nodes the root does
 * not reach (a second fragment) are not written: the file has one graph per
 * sentence, and the canvas and validation show the fragment.
 */
export function toUmrSentences(graph) {
  const { sentences, nodesById } = graph;

  return sentences.map((s) => {
    const nodes = new Map();
    s.nodes.forEach((node) => {
      const children = [
        ...node.attrs.map((a) => ({
          rel: a.rel,
          kind: a.value.startsWith('"') ? 'string' : 'atom',
          value: a.value,
          order: a.order ?? 0,
        })),
        ...node.out
          .filter((e) => nodesById.get(e.target)?.sentence === s.index)
          .map((e) => ({
            rel: e.role,
            kind: 'node',
            value: nodesById.get(e.target).var,
            inline: false,
            order: e.order,
          })),
      ].sort((a, b) => a.order - b.order);
      nodes.set(node.var, { var: node.var, concept: node.concept, children });
    });
    const root = s.roots[0]?.var ?? null;
    let penman = null;
    if (root) {
      penman = { root, nodes, errors: [] };
      for (const [parent, index] of treeEdges(penman)) {
        nodes.get(parent).children[index].inline = true;
      }
    }

    const alignment = new Map();
    s.nodes.forEach((node) => alignment.set(node.var, node.alignment));

    const groups = { temporal: [], modal: [], coref: [] };
    const nameOf = (id) => nodesById.get(id)?.var;
    s.triples.forEach((t) => groups[t.group].push([nameOf(t.source), t.rel, nameOf(t.target)]));
    const hasTriples = groups.temporal.length || groups.modal.length || groups.coref.length;

    return {
      index: s.index,
      snt: s.snt || s.index,
      sentenceText: s.text,
      meta: s.meta,
      ilg: ilgLines(s),
      words: s.words.map((w) => w.text),
      graph: penman,
      rawGraph: s.rawGraph,
      rawAlignment: s.rawAlignment,
      alignment,
      docGraph: hasTriples ? { var: `s${s.index}s0`, ...groups } : null,
    };
  });
}

// The gloss lines to write: Index and Words regenerated from the word layer
// so they can never drift from the text, then the sentence's resolved lines.
function ilgLines(s) {
  const words = s.words.map((w) => w.text);
  return [
    { header: 'Index', key: 'index', lang: null, items: words.map((_, i) => String(i + 1)) },
    { header: 'Words', key: 'words', lang: null, items: words },
    ...(s.ilg || []).map(({ header, key, lang, items }) => ({ header, key, lang, items })),
  ];
}

/**
 * The next free variable for a concept in a sentence, by the standard rule:
 * `s` + sentence number + the concept's first letter (`x` when that is not a
 * letter) + a counter from 2 on when the bare form is taken.
 */
export function nextVariable(sentenceIndex, concept, taken) {
  const first = String(concept || '')
    .charAt(0)
    .toLowerCase();
  const letter = /\p{Ll}/u.test(first) ? first : 'x';
  const base = `s${sentenceIndex}${letter}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
