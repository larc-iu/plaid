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
//            modal or coref. A triple between two constants belongs to no
//            sentence by itself: the records of the sentences whose blocks
//            write it list it (`triples` below), and one just made lists
//            those sentences by number (`sentences`) until reconcile puts it
//            in their records
//   record = a token in the UMR node layer that carries metadata.umr (an
//            anchor carries none) = { snt?, text?, ilg?, meta?, rawGraph?,
//            rawAlignment?, held?, triples? }: what a sentence's file block
//            said beyond its graph. The raw pair holds a graph the parser
//            could not read, kept as text so nothing is lost, `held` the
//            document-level relations this sentence's block wrote that name
//            a node of such a graph, by name: [{ source, rel, target, group
//            }], made real when the graph is mended, and `triples` the ids of
//            the triples between two constants the block writes. A record
//            belongs to the sentence its token begins in. Its token stands
//            over the text of its sentence and is no sentence token, so
//            another app joining two sentences (which deletes the second
//            sentence token) leaves both records standing over their own
//            halves, and a split back where they were gives each its own
//            sentence again
//
// By its real path rather than through `@ui`: the node suite has no alias.
import { cpSlicer } from '@larc-iu/plaid-client';
import { UMR_NAMESPACE } from '../utils/umrLayerUtils.js';
import { treeEdges, serializePenman } from './format/penman.js';
import { perWordStored } from './ilg.js';
import { CYCLE_ROLES, DOC_CONSTANTS } from './format/inventory.js';

const umrMeta = (entity) => entity?.metadata?.[UMR_NAMESPACE] || {};

// Half-open containment of a zero-width or positive-width piece in a range.
const beginsIn = (piece, range) => piece.begin >= range.begin && piece.begin < range.end;

// Positive overlap between two ranges.
const overlaps = (a, b) => a.begin < b.end && b.begin < a.end;

const byBegin = (a, b) => a.begin - b.begin || a.end - b.end;

/** Whether a token of the UMR node layer is a sentence's record, not an anchor. */
export const isRecordToken = (token) => {
  const meta = token?.metadata?.[UMR_NAMESPACE];
  return !!meta && typeof meta === 'object';
};

// What a record says of the sentence it describes (the file's number, its
// text where that is not the words, its gloss lines, its other metadata
// lines, a graph kept as text and the relations held on it), as the sentence
// object's fields. `recordToken` is the record's token, null for a sentence
// that records nothing (one made in Plaid).
function recordFields(holder, sentence, slice) {
  const meta = umrMeta(holder);
  return {
    recordToken: holder ? holder.id : null,
    text: meta.text || slice(sentence.begin, sentence.end).replace(/\n+$/, ''),
    // What an import stored, and (once the words are known) the lines the
    // mapping resolves them and the layers into (`ilg`).
    storedIlg: meta.ilg || [],
    meta: meta.meta || [],
    snt: meta.snt || null,
    rawGraph: meta.rawGraph || null,
    rawAlignment: meta.rawAlignment || null,
    held: Array.isArray(meta.held) ? meta.held : [],
  };
}

// `s<number><rest>`: a variable's sentence number, then a letter and
// whatever follows.
export const NUMBERED_VARIABLE = /^s([0-9]+)(\p{L}.*)$/u;

/**
 * The one sentence number the variables of a sentence's nodes carry, or null
 * when they carry none or disagree. A variable names the sentence it was made
 * in, so after another app adds or removes a sentence before it, this is the
 * number the sentence had, until reconcile renumbers it.
 */
function variableNumber(sentence) {
  let number = null;
  for (const node of sentence.nodes) {
    const m = NUMBERED_VARIABLE.exec(node.var || '');
    if (!m) continue;
    if (number !== null && Number(m[1]) !== number) return null;
    number = Number(m[1]);
  }
  return number;
}

/**
 * Whether the document goes by the sentence numbers its file stored rather
 * than by position: the first stored `# :: snt` number is not 1, as in a
 * released excerpt starting at snt5. Its variables are left as the file
 * named them (umrReconcile.js `planRenumber`) and its export writes the
 * stored numbers. Every other document is numbered by position, a stored
 * number included, once IGT has added or removed a sentence.
 */
export function numberedByFile(sentences) {
  const first = (sentences || []).find((s) => s.snt != null);
  return !!first && String(first.snt) !== '1';
}

// A record can stand over new text typed in before its sentence: IGT types
// a sentence in before the first one by growing the first sentence over the
// new text and splitting it off, and core cuts a token of exactly the split
// sentence's extent (the record's) at the split, so the record is left on
// the new text, the left half, while its words and its graph are in the
// right half, which records nothing. The record goes with the graph it
// describes: a sentence that records something and has no nodes, followed
// (past any sentences that record nothing and have no nodes either, several
// typed in at once) by one that records nothing and whose nodes' variables
// carry the first one's number. Reconcile then moves the record there for
// good.
//
// The number must say so without doubt, since a sentence the file left with
// no graph (or one whose graph was deleted) followed by one added in IGT and
// annotated has the same shape. So the variables must not carry the added
// sentence's own position, which is how a new node is named, and the number
// must be the one the record's own sentence went by: its stored `snt` in a
// document numbered by its file, and in any other both its position and its
// stored `snt`, which an insertion before it since the import would part.
function recordsFollowTheirGraphs(sentences, slice, tokensById) {
  const byFile = numberedByFile(sentences);
  sentences.forEach((s, i) => {
    if (!s.recordToken || s.nodes.length) return;
    let j = i + 1;
    while (j < sentences.length && !sentences[j].recordToken && !sentences[j].nodes.length) j++;
    const to = sentences[j];
    if (!to || to.recordToken || !to.nodes.length) return;
    const number = variableNumber(to);
    if (number === null || number === to.index) return;
    const stored = String(number) === String(s.snt);
    if (!(byFile ? stored : stored && number === s.index)) return;
    Object.assign(to, recordFields(tokensById.get(s.recordToken), to, slice));
    const [next = null, ...rest] = s.otherRecords;
    Object.assign(s, recordFields(next && tokensById.get(next), s, slice));
    s.otherRecords = rest;
  });
}

/**
 * The sentence a stored sentence number now names, for a triple between two
 * constants that lists the sentences whose blocks write it by number. A
 * number is a position when it was written, so after another app adds or
 * removes a sentence before it, it names the sentence whose variables still
 * carry it. A number no sentence's variables carry, and every number in a
 * document numbered by its file, is read as it is.
 *
 * @returns {(n: number) => number}
 */
export function sentenceNumberReader(sentences) {
  if (numberedByFile(sentences)) return (n) => n;
  // Each number, the sentences whose variables carry it: two sentences
  // joined in IGT carry both numbers, and a number two sentences carry (one
  // split in two) says nothing about where it went.
  const holders = new Map();
  sentences.forEach((s) =>
    s.nodes.forEach((node) => {
      const m = NUMBERED_VARIABLE.exec(node.var || '');
      if (!m) return;
      const n = Number(m[1]);
      if (!holders.has(n)) holders.set(n, new Set());
      holders.get(n).add(s.index);
    }),
  );
  return (n) => {
    const at = holders.get(n);
    return at?.size === 1 ? [...at][0] : n;
  };
}

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
  // One code-point view of the body for every slice below: `cpSlice` spread
  // the whole body once per word, which on a 320-sentence document was about
  // 120 ms of every rebuild, and grew with words times body length.
  const slice = cpSlicer(body);
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
  const sentences = sentenceTokens.map((token, i) => ({
    index: i + 1,
    tokenId: token.id,
    begin: token.begin,
    end: token.end,
    ...recordFields(null, token, slice),
    // The records after the first that stand in this sentence: a sentence
    // joined to the one before it in another app holds both records until
    // it is split again. The first is the sentence's own (`recordToken`).
    otherRecords: [],
    words: [],
    morphemes: [],
    ilg: [],
    nodes: [],
    edges: [],
    triples: [],
  }));
  const sentenceOf = (piece) => sentences.find((s) => beginsIn(piece, s));
  const byTokenId = new Map(sentences.map((s) => [s.tokenId, s]));
  // Each record is read with the sentence its token begins in, in text order.
  const recordTokens = nodeTokens.filter(isRecordToken).sort(byBegin);
  const recordsById = new Map(recordTokens.map((t) => [t.id, t]));
  recordTokens.forEach((token) => {
    const s = sentenceOf(token);
    if (!s) return;
    if (s.recordToken) s.otherRecords.push(token.id);
    else Object.assign(s, recordFields(token, s, slice));
  });
  // Whether a word of the text overlaps the piece.
  const overWord = (piece) => {
    const s = sentenceOf(piece);
    return !!s && s.words.some((w) => overlaps(piece, w));
  };

  wordTokens.forEach((token) => {
    const s = sentenceOf(token);
    if (!s) return;
    s.words.push({
      id: token.id,
      index: s.words.length + 1,
      begin: token.begin,
      end: token.end,
      text: slice(token.begin, token.end),
      metadata: token.metadata || null,
    });
  });
  // A morpheme token covers the WHOLE of its word, by the shared token
  // hierarchy: the segmentation lives in `metadata.form` and the extent says
  // only which word the morpheme belongs to. Reading the baseline between its
  // offsets therefore gave every morpheme of a word the same text, the word
  // itself, once per morpheme, on the canvas and in an exported file alike.
  //
  // An empty form is IGT's "emptied by hand" and is left empty rather than
  // falling back to the word: the gloss line writes it as `_`, which is what
  // a morpheme with no form is.
  morphemeTokens.forEach((token) => {
    const s = sentenceOf(token);
    if (!s) return;
    const form = token.metadata?.form;
    s.morphemes.push({
      id: token.id,
      begin: token.begin,
      end: token.end,
      text: typeof form === 'string' ? form : slice(token.begin, token.end),
      // The FLEx morph-type name, which says how this morpheme joins the one
      // before it when the word is drawn. Absent on every hand-entered one.
      morphType: token.metadata?.morphType ?? null,
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
      // Aligned to words: no sentence record, and a word under the anchor.
      // Reading the anchor's width alone was only true while an unaligned
      // node stood on a point of text, which a deletion across that point
      // took away with the node on it. And a word deleted in another app
      // leaves the anchor over its text with no word there: such a node was
      // drawn aligned while the export wrote `0-0`. Reconcile makes it an
      // ordinary unaligned node (umrReconcile.js), and a view that does not
      // reconcile (a past state, a reader) reads it as one already.
      aligned: !meta.sentence && pieces.some((p) => p.end > p.begin && overWord(p)),
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
    //
    // Unless the anchor begins in a LATER sentence. IGT splits a sentence
    // keeping its token on the left, so a sentence typed in before the first
    // one and split off takes the first one's token, and with it the record
    // of every unaligned node there, while their anchors and their trees are
    // in the right half. Nothing else puts a recorded sentence before where
    // the anchor begins.
    const recorded = node.aligned ? null : byTokenId.get(meta.sentence);
    const standing = pieces.length ? sentenceOf(pieces[0]) : null;
    const s = recorded && !(standing && standing.index > recorded.index) ? recorded : standing;
    if (s) {
      node.sentence = s.index;
      s.nodes.push(node);
    }
  });

  recordsFollowTheirGraphs(sentences, slice, recordsById);
  // Every record with the sentence it is read with, for reconcile.
  const records = sentences.flatMap((s) =>
    [s.recordToken, ...s.otherRecords].filter(Boolean).map((id, k) => {
      const token = recordsById.get(id);
      return {
        id,
        sentence: s.index,
        own: k === 0,
        begin: token.begin,
        end: token.end,
        record: umrMeta(token),
      };
    }),
  );
  // The triples between two constants each sentence's records list.
  const listedIn = new Map();
  records.forEach(({ sentence, record }) =>
    (Array.isArray(record.triples) ? record.triples : []).forEach((id) => {
      if (!listedIn.has(id)) listedIn.set(id, new Set());
      listedIn.get(id).add(sentence);
    }),
  );

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
  // two constants belongs to the sentences whose records list it, and to
  // those its own metadata lists by the number each had when it was written
  // (sentenceNumberReader), until reconcile puts it in their records.
  const numberNow = sentenceNumberReader(sentences);
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
      const blocks = new Set(listedIn.get(rel.id) || []);
      (meta.sentences || []).forEach((n) => blocks.add(numberNow(n)));
      [...blocks].sort((a, b) => a - b).forEach((n) => sentences[n - 1]?.triples.push(triple));
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

  return { sentences, constants, nodesById, chains, records };
}

/**
 * `next` with every sentence that reads exactly as it did in `prev` replaced
 * by `prev`'s object, and `nodesById` pointing at that object's nodes, so a
 * screen that memoizes per sentence skips the ones an edit did not touch. On a
 * 320-sentence document an edit re-rendered every block on the page.
 *
 * "Reads exactly as it did" is the sentence object itself, compared whole,
 * plus what it shows of the rest of the document: the nodes at the far end of
 * its edges and triples in other sentences (a tag names the other node's
 * variable), and the size of each coreference chain its nodes are in. Returns
 * `next` itself when there is nothing to keep.
 */
export function keepUnchangedSentences(prev, next) {
  if (!prev || !next) return next;
  const before = new Map(prev.sentences.map((s) => [s.tokenId, s]));
  let kept = 0;
  const sentences = next.sentences.map((s) => {
    const old = before.get(s.tokenId);
    if (!old || sentenceKey(old, prev) !== sentenceKey(s, next)) return s;
    kept += 1;
    return old;
  });
  if (!kept) return next;
  const nodesById = new Map(next.nodesById);
  sentences.forEach((s, i) => {
    if (s !== next.sentences[i]) s.nodes.forEach((n) => nodesById.set(n.id, n));
  });
  return { ...next, sentences, nodesById };
}

// What a sentence shows, as one string: see keepUnchangedSentences. Cached
// on the object, which is never changed once built.
const KEY = Symbol('sentenceKey');
function sentenceKey(s, { nodesById, chains }) {
  if (s[KEY]) return s[KEY];
  const own = new Set(s.nodes.map((n) => n.id));
  const far = new Map();
  const note = (id) => {
    if (own.has(id) || far.has(id)) return;
    const n = nodesById.get(id);
    far.set(id, n ? [n.var, n.concept, n.sentence, n.constant, n.chain] : null);
  };
  s.nodes.forEach((n) => {
    n.in.forEach((e) => note(e.source));
    n.out.forEach((e) => note(e.target));
    [...n.docIn, ...n.docOut].forEach((t) => {
      note(t.source);
      note(t.target);
    });
  });
  s.triples.forEach((t) => {
    note(t.source);
    note(t.target);
  });
  // Every field but `edges` and `roots`, which repeat what the nodes hold
  // (each node's edges out, and which nodes are roots, by id).
  const { edges: _edges, roots, ...rest } = s;
  const chainSizes = s.nodes.map((n) => (n.chain == null ? null : chains[n.chain]?.nodes.length));
  const key = JSON.stringify([rest, roots.map((r) => r.id), [...far], chainSizes]);
  Object.defineProperty(s, KEY, { value: key });
  return key;
}

// The coreference relations, whichever way they point, join nodes into chains.
const COREF_RELATIONS = new Set([':same-entity', ':same-event', ':subset-of', ':subset']);

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

// An edge with a cycle role (CYCLE_ROLES) into a node does not make it a
// child, so the root of `(s / say-01 :ARG1 (b / believe-01 :quote s))` is
// still say-01.
//
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
export function writtenIds(sentence, nodesById) {
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
function alignmentOf(node, words) {
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
 * and `(s1l :before s3b)` reads `:before s3b` on s1l (s3b before s1l: a
 * temporal label says how the target stands to the source). Direction is the
 * whole of what the relation says, and a tag that always put the other end
 * first reversed it.
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

/**
 * Variables that name more than one stored node, as `{ var, nodes }`. Read
 * over `nodesById`, since every map keyed by
 * variable (the export's, the checks') keeps only the last of them: two nodes
 * one variable names were written as one re-entrant node and nothing said so.
 * Constants are left out, since a triple's constant is found by its name.
 */
const sharedVariables = (graph) => {
  const byVar = new Map();
  graph.nodesById.forEach((n) => {
    if (n.constant || !n.var) return;
    if (!byVar.has(n.var)) byVar.set(n.var, []);
    byVar.get(n.var).push(n);
  });
  return [...byVar]
    .filter(([, nodes]) => nodes.length > 1)
    .map(([v, nodes]) => ({ var: v, nodes }));
};

/**
 * Two nodes of ONE sentence under one variable, as an error on that
 * sentence. Two sentences sharing one are the official check's to report
 * (validate.js, `non-unique-node-id`), since both graphs reach it whole, and
 * the file reads back as it was.
 */
export const variablesSharedInSentence = (graph) => {
  const out = [];
  sharedVariables(graph).forEach(({ var: v, nodes }) => {
    const counts = new Map();
    nodes.forEach((n) => {
      if (n.sentence != null) counts.set(n.sentence, (counts.get(n.sentence) || 0) + 1);
    });
    counts.forEach((count, sentence) => {
      if (count < 2) return;
      out.push({
        level: 'error',
        code: 'non-unique-node-id',
        sentence,
        var: v,
        message: `Variable '${v}' names ${count} nodes.`,
      });
    });
  });
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
  // The names a held relation may use (see buildDocumentGraph): a written
  // node's, a constant's, and a variable a graph kept as text defines while
  // that text is what the file writes.
  const named = new Set(DOC_CONSTANTS);
  written.forEach((id) => named.add(nodesById.get(id)?.var));
  sentences.forEach((s) => {
    if (s.nodes.length || typeof s.rawGraph !== 'string') return;
    for (const m of s.rawGraph.matchAll(KEPT_VARIABLE)) named.add(m[1]);
  });
  const sntOf = fileNumbers(sentences);

  return sentences.map((s) => {
    // Only the nodes the file writes: the alignment block and the checks read
    // this map, and a node left out still wrote its line (`0-0`, for want of
    // one) and failed the official checks.
    const nodes = penmanNodes(s, nodesById, (node) => written.has(node.id));
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
    // Held relations, back in the block that wrote them, while both names
    // are in the file.
    s.held.forEach((h) => {
      if (named.has(h.source) && named.has(h.target) && groups[h.group]) {
        groups[h.group].push([h.source, h.rel, h.target]);
      }
    });
    const hasTriples = groups.temporal.length || groups.modal.length || groups.coref.length;

    return {
      index: s.index,
      snt: sntOf.get(s),
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

// The number each sentence's `# :: snt` line writes: its position, as its
// variables carry it, unless the document goes by its file's numbers
// (numberedByFile). Then a stored number is written as it is, and a sentence
// that stores none, or repeats one, is written by position, or past the
// highest number when that is taken: the official validator refuses a
// repeated number. A sentence typed in before the first one in IGT stored
// nothing, and its position repeated the old first sentence's stored 1.
function fileNumbers(sentences) {
  const out = new Map();
  if (!numberedByFile(sentences)) {
    sentences.forEach((s) => out.set(s, s.index));
    return out;
  }
  const taken = new Set();
  const numeric = (n) => (/^[0-9]+$/.test(String(n)) ? Number(n) : 0);
  let highest = Math.max(0, ...sentences.map((s) => numeric(s.snt ?? 0)), sentences.length);
  const stored = new Map();
  sentences.forEach((s) => {
    if (s.snt == null || stored.has(String(s.snt))) return;
    stored.set(String(s.snt), s);
  });
  sentences.forEach((s) => {
    if (s.snt != null && stored.get(String(s.snt)) === s) {
      out.set(s, s.snt);
      taken.add(String(s.snt));
    }
  });
  sentences.forEach((s) => {
    if (out.has(s)) return;
    let n = s.index;
    if (taken.has(String(n))) n = ++highest;
    out.set(s, n);
    taken.add(String(n));
  });
  return out;
}

// A variable a graph kept as text defines: the name before a slash after an
// opening bracket.
export const KEPT_VARIABLE = /\(\s*([^\s/()"]+)\s*\//g;

/**
 * The variables the graphs kept as text still define: a sentence's own, while
 * it has no nodes, and that of every record waiting in a sentence joined to
 * the one before it, which a split gives its sentence back. A renumbered
 * node must not take one of them.
 */
export function keptVariables(graph) {
  const names = new Set();
  const bySentence = graph.sentences || [];
  (graph.records || []).forEach(({ sentence, own, record }) => {
    if (typeof record.rawGraph !== 'string') return;
    if (own && bySentence[sentence - 1]?.nodes.length) return;
    for (const m of record.rawGraph.matchAll(KEPT_VARIABLE)) names.add(m[1]);
  });
  return names;
}

// A sentence's nodes as parsePenman's map, each node's attributes and
// in-sentence edges in their stored order. `keep` picks the nodes.
function penmanNodes(s, nodesById, keep = () => true) {
  const nodes = new Map();
  s.nodes.forEach((node) => {
    if (!keep(node)) return;
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
  return nodes;
}

/**
 * EVERY node of a sentence as PENMAN, for text mode: the root's graph, as the
 * file writes it, then each part the root does not reach as a graph of its
 * own, in the canvas's order of roots. A node is written out once, in the
 * first graph that reaches it, and named by its variable anywhere after.
 */
export function sentencePenman(s, nodesById) {
  const all = penmanNodes(s, nodesById);
  const shown = new Set();
  const parts = [];
  const tops = [...s.roots.map((r) => r.var), ...all.keys()];
  tops.forEach((top) => {
    if (shown.has(top) || !all.has(top)) return;
    const nodes = new Map([...all].filter(([v]) => !shown.has(v)));
    parts.push(serializePenman({ root: top, nodes }));
    const stack = [top];
    while (stack.length) {
      const v = stack.pop();
      if (shown.has(v) || !nodes.has(v)) continue;
      shown.add(v);
      nodes.get(v).children.forEach((c) => c.kind === 'node' && stack.push(c.value));
    }
  });
  return parts.join('\n\n');
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
 * `s` + sentence number + the concept's first letter + a counter from 2 on
 * when the bare form is taken.
 *
 * The letter is always one of a to z: an accented letter gives its base
 * letter (`ébrio` gives `s4e`), anything else `x`. The spec allows accented
 * variables, but validate.py reads them only in the sentence graph, and the
 * first document-level relation on `s4é` failed its sentence's whole block.
 * A person may still type one (the owner's ruling): only the name the app
 * picks by itself is held to ASCII.
 */
export function nextVariable(sentenceIndex, concept, taken) {
  const first = String(concept || '')
    .charAt(0)
    .toLowerCase()
    .normalize('NFD')
    .charAt(0);
  const letter = /^[a-z]$/.test(first) ? first : 'x';
  const base = `s${sentenceIndex}${letter}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
