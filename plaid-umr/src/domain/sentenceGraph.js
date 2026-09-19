// The one reading of a UMR document's layers: from the raw document's tokens,
// spans and relations to per-sentence graphs, and from those graphs to the
// sentence objects the .umr serializer takes. What the canvas draws and what
// the exporter writes come from here, so they cannot disagree.
//
// Storage (see docs/umr/DESIGN.md):
//   node   = a span in the concept layer, value = concept, tokens = the anchor
//            pieces in the UMR node layer (the whole sentence when the node is
//            aligned to no word), metadata.umr = { var, attrs: [{ rel, value,
//            order }], constant?, root?, sentence? } where `root` marks the
//            sentence's root and `sentence` is its sentence token's id. A node
//            RECORDS a sentence exactly when it is aligned to no word: the
//            record is what says so, and the anchor is only where the node
//            stands (see umrReconcile.js)
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
import { perWordStored } from './ilg.js';

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
  const byTokenId = new Map(sentences.map((s) => [s.tokenId, s]));

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
      // Aligned to words, which is what the absence of a sentence record
      // says. Reading the anchor's width instead was only true while an
      // unaligned node stood on a point of text, which a deletion across
      // that point took away with the node on it.
      aligned: !meta.sentence && pieces.some((p) => p.end > p.begin),
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
    // An unaligned node belongs to the sentence it records, while that
    // sentence is alive: another app's edit at a sentence's start moves its
    // anchor into the sentence before, and reading position alone drew it,
    // and wrote it to the file, under that one. Reconcile brings the anchor
    // back; the canvas, the export and the Export tab agree before it runs.
    const recorded = node.aligned ? null : byTokenId.get(meta.sentence);
    const s = recorded || (pieces.length ? sentenceOf(pieces[0]) : null);
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
      // A node aligned to no word covers its whole sentence, which is where
      // it stands and not what it is about: it aligns to nothing and lights
      // up no word.
      node.alignment = node.aligned ? alignmentOf(node, s.words) : [];
      node.wordIds = node.aligned
        ? node.pieces
            .flatMap((p) => s.words.filter((w) => overlaps(p, w)).map((w) => w.id))
            .filter((id, i, arr) => arr.indexOf(id) === i)
        : [];
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
    // The stored group first: `:contains` is temporal in one group and
    // coreference in the other, and the import records which.
    const group = umrMeta(rel).group;
    const isCoref = group ? group === 'coref' : COREF_RELATIONS.has(rel.value);
    if (!isCoref) return;
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

// Without a mapping, the stored lines as they were, laid under the words
// wherever the file lets that be told (ilg.js, perWordStored).
const storedLines = (s) =>
  perWordStored(
    (s.storedIlg || []).filter((line) => line.key !== 'index' && line.key !== 'words'),
    s.words.length,
  );

// The roles a graph may cycle through (the validator allows no others): an
// edge with one of these into a node does not make it a child, so the root
// of `(s / say-01 :ARG1 (b / believe-01 :quote s))` is still say-01.
export const CYCLE_ROLES = new Set([':quote', ':modal-predicate']);

// The sentence's roots. A node marked as the root (the file's own, kept at
// import) is one whatever reaches it, since a graph may cycle back into its
// root through more than :quote in the released data. Then one root for each
// part of the sentence no root reaches, a FRAGMENT: a node of it nothing
// reaches but a cycle role (the :quote back into a reported-speech root),
// the largest part first; and for a cycle with no way in, the node that
// reaches the most of it, ties to the first in anchor order. A node the
// marked root reaches is never a root, so a quoted clause made the root does
// not turn the old root (re-entered only by :quote) into a second one.
//
// The export writes the first root's graph only; `unreachedByRoot` reports
// the rest.
function rootsOf(sentence, nodesById) {
  if (!sentence.nodes.length) return [];
  const inSentence = (id) => nodesById.get(id)?.sentence === sentence.index;
  const reach = (starts, into = new Set()) => {
    const stack = [...starts];
    while (stack.length) {
      const n = stack.pop();
      if (!n || into.has(n.id)) continue;
      into.add(n.id);
      n.out.forEach((e) => {
        if (inSentence(e.target)) stack.push(nodesById.get(e.target));
      });
    }
    return into;
  };
  const roots = sentence.nodes.filter((n) => n.root);
  const reached = reach(roots);
  const newReach = (n) => [...reach([n])].filter((id) => !reached.has(id)).length;
  const unreached = () => sentence.nodes.filter((n) => !reached.has(n.id));
  const entries = unreached()
    .filter((n) => !n.in.some((e) => inSentence(e.source) && !CYCLE_ROLES.has(e.role)))
    .map((n) => ({ n, size: newReach(n) }))
    .sort((a, b) => b.size - a.size);
  entries.forEach(({ n }) => {
    if (reached.has(n.id)) return;
    roots.push(n);
    reach([n], reached);
  });
  for (let left = unreached(); left.length; left = unreached()) {
    let best = left[0];
    let bestSize = -1;
    left.forEach((n) => {
      const size = newReach(n);
      if (size > bestSize) {
        best = n;
        bestSize = size;
      }
    });
    roots.push(best);
    reach([best], reached);
  }
  return roots;
}

// The ids of the nodes the export writes for a sentence: what its first root
// reaches.
function writtenIds(sentence, nodesById) {
  const seen = new Set();
  const stack = sentence.roots.slice(0, 1);
  while (stack.length) {
    const n = stack.pop();
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    n.out.forEach((e) => {
      const t = nodesById.get(e.target);
      if (t?.sentence === sentence.index) stack.push(t);
    });
  }
  return seen;
}

/**
 * The parts of each sentence its root does not reach: the export writes one
 * graph a sentence, the first root's, and leaves them out. Reported as errors
 * on each part's root. Before this a part left out could go without a word:
 * an edge deleted into a cycle, a leaf in a cycle made the root.
 */
export const unreachedByRoot = (graph) => {
  const out = [];
  graph.sentences.forEach((s) => {
    if (s.roots.length < 2) return;
    const written = writtenIds(s, graph.nodesById);
    const root = s.roots[0].var;
    s.roots.slice(1).forEach((r) => {
      const part = new Set();
      const stack = [r];
      while (stack.length) {
        const n = stack.pop();
        if (!n || part.has(n.id) || written.has(n.id)) continue;
        part.add(n.id);
        n.out.forEach((e) => {
          const t = graph.nodesById.get(e.target);
          if (t?.sentence === s.index) stack.push(t);
        });
      }
      const n = part.size - 1;
      const what = n ? `${r.var} and ${n} node${n === 1 ? '' : 's'} under it are` : `${r.var} is`;
      out.push({
        level: 'error',
        code: 'unreached-by-root',
        sentence: s.index,
        var: r.var,
        message: `${what} not reached from the root ${root}, and the export leaves ${n ? 'them' : 'it'} out.`,
      });
    });
  });
  return out;
};

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

/**
 * The tag a node wears for a document-level triple it takes part in: the
 * triple read in its OWN order with the node itself left out, so
 * `(author :full-affirmative s1l)` reads `author :full-affirmative` on s1l
 * and `(s1l :before document-creation-time)` reads `:before
 * document-creation-time` on s1l. Direction is the whole of what the
 * relation says, and a tag that always put the other end first reversed it.
 *
 * @param {{source: string, target: string, rel: string}} triple
 * @param {string} selfId the node wearing the tag
 * @param {string} otherVar what the other end is called
 */
export const docTagText = (triple, selfId, otherVar) =>
  triple.source === selfId ? `${triple.rel} ${otherVar}` : `${otherVar} ${triple.rel}`;

/**
 * The modality nearly every event carries, `(author :full-affirmative x)`:
 * the document-level triple that says least, grey on its tag and its line.
 */
export const isDefaultModality = (triple, nodesById) => {
  const source = nodesById.get(triple.source);
  return !!source?.constant && source.var === 'author' && triple.rel === ':full-affirmative';
};

/**
 * Every document-level tag a node wears, at whichever end of the triple it
 * is, and in the order it wears them: a constant at the other end first
 * (the modal and temporal anchoring of an event), then a node of its own
 * sentence, then a node of another sentence, the nearest sentence first.
 *
 * A triple is written in the block of the later of its two sentences, but
 * the earlier node takes part in it as much as the later one, so both wear
 * it. Across the released corpora most node-to-node triples cross a
 * sentence (512 of 774), and a tag on the later end alone left the earlier
 * node looking unrelated.
 *
 * @returns {{id, source, target, rel, group, text, otherId, cross: boolean}[]}
 */
export const docTagsOf = (node, nodesById) => {
  const seen = new Set();
  const tags = [];
  [...(node.docOut || []), ...(node.docIn || [])].forEach((t) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    const otherId = t.source === node.id ? t.target : t.source;
    const other = nodesById.get(otherId);
    if (!other) return;
    const rank = other.constant ? 0 : other.sentence === node.sentence ? 1 : 2;
    const distance = rank === 2 ? Math.abs((other.sentence ?? 0) - (node.sentence ?? 0)) : 0;
    tags.push({
      key: [rank, distance],
      tag: {
        id: t.id,
        source: t.source,
        target: t.target,
        rel: t.rel,
        group: t.group,
        text: docTagText(t, node.id, other.var),
        otherId,
        otherVar: other.var,
        cross: rank === 2,
        isDefault: isDefaultModality(t, nodesById),
      },
    });
  });
  return tags.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1]).map((x) => x.tag);
};

/**
 * The sentence-level edges whose two ends are in different sentences: what
 * splitting a sentence in another app makes of an edge between its halves.
 * They stay stored (merging the sentences back makes them whole) and the
 * export leaves them out, since a sentence graph cannot reach into another,
 * so each is reported here as an error on the node it leaves. Before this
 * the export dropped them and nothing said so.
 */
export const crossSentenceEdges = (graph) => {
  const out = [];
  graph.sentences.forEach((s) =>
    s.edges.forEach((e) => {
      const target = graph.nodesById.get(e.target);
      if (!target || target.sentence === s.index) return;
      const where =
        target.sentence == null ? 'outside every sentence' : `into sentence ${target.sentence}`;
      out.push({
        level: 'error',
        code: 'edge-across-sentences',
        sentence: s.index,
        var: graph.nodesById.get(e.source)?.var ?? null,
        message: `${e.role} to ${target.var} reaches ${where}, and the export leaves it out.`,
      });
    }),
  );
  return out;
};

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
  // What the file will hold, across the document: a triple naming a node the
  // export leaves out is left out with it, as its alignment line is.
  const written = new Set();
  sentences.forEach((s) => writtenIds(s, nodesById).forEach((id) => written.add(id)));
  const inFile = (id) => nodesById.get(id)?.constant || written.has(id);

  return sentences.map((s) => {
    // Only the nodes the file writes: the alignment block and the checks read
    // this map, and a node left out still wrote its line (`0-0`, for want of
    // one) and failed the official checks.
    const nodes = new Map();
    s.nodes.forEach((node) => {
      if (!written.has(node.id)) return;
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
    s.nodes.forEach((node) => {
      if (written.has(node.id)) alignment.set(node.var, node.alignment);
    });

    const groups = { temporal: [], modal: [], coref: [] };
    const nameOf = (id) => nodesById.get(id)?.var;
    s.triples.forEach((t) => {
      if (inFile(t.source) && inFile(t.target)) {
        groups[t.group].push([nameOf(t.source), t.rel, nameOf(t.target)]);
      }
    });
    const hasTriples = groups.temporal.length || groups.modal.length || groups.coref.length;

    return {
      index: s.index,
      snt: s.snt || s.index,
      sentenceText: s.text,
      meta: s.meta,
      ilg: ilgLines(s),
      words: s.words.map(wordForFile),
      graph: penman,
      // A graph kept as text is written back only while the sentence has no
      // nodes: once one is made, on the canvas or in text mode, the graph the
      // annotator sees is the one written.
      rawGraph: s.nodes.length ? undefined : s.rawGraph,
      rawAlignment: s.nodes.length ? undefined : s.rawAlignment,
      alignment,
      docGraph: hasTriples ? { var: `s${s.index}s0`, ...groups } : null,
    };
  });
}

// A word as the file's Words line holds it. The line is split on spaces, so
// a word with one inside (two merged in IGT, "in order") is written with `_`:
// kept whole, it was two items against one index, and every alignment after
// it pointed one word early.
export const wordForFile = (w) => w.text.trim().replace(/\s+/g, '_');

// The gloss lines to write: Index and Words regenerated from the word layer
// so they can never drift from the text, then the sentence's resolved lines.
function ilgLines(s) {
  const words = s.words.map(wordForFile);
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
