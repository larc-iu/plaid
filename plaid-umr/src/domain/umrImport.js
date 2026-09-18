// .umr import: text in, a new document in the project out.
//
// The text is the sentences' words joined by spaces, one sentence per line,
// since a .umr file carries tokens and not a text. Sentences tile the text
// (the sentence layer is partitioning), each taking the newline after it.
import { cpLength } from '@larc-iu/plaid-client';
import { UMR_NAMESPACE, missingUmrLayerLabels } from '../utils/umrLayerUtils.js';
import { parseUmrFile } from './format/umrFile.js';
import { DOC_CONSTANTS } from './format/inventory.js';

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {object} client
 * @param {string} projectId
 * @param {string} name the document's name
 * @param {string} text the .umr file
 * @param {object} layerInfo from getUmrLayerInfo(project), configured
 * @returns {Promise<{ document: { id: string, name: string }, warnings: string[] }>}
 */
export async function importUmrDocument(client, projectId, name, text, layerInfo) {
  if (!name || !name.trim()) throw new Error('Document name is required');
  if (!text || !text.trim()) throw new Error('No content to import');
  if (!layerInfo?.isConfigured) {
    const labels = missingUmrLayerLabels(layerInfo?.missingLayers).join(', ');
    throw new Error(`The project is missing UMR layers: ${labels || 'set the project up first'}.`);
  }

  const parsed = parseUmrFile(text);
  if (!parsed.sentences.length) {
    const first = parsed.errors?.[0];
    throw new Error(
      first ? `The file could not be read: ${first.message}` : 'No sentences found in the file',
    );
  }
  const warnings = [
    ...(parsed.warnings || []).map((w) => (typeof w === 'string' ? w : w.message)),
    ...(parsed.errors || []).map((e) => (typeof e === 'string' ? e : e.message)),
  ];

  const plan = planImport(parsed.sentences, warnings);

  let documentId = null;
  try {
    const created = await client.documents.create(projectId, name);
    documentId = created.id;
    const textResponse = await client.texts.create(layerInfo.textLayer.id, documentId, plan.body);
    const textId = textResponse.id;

    // Tokens: sentences, words and node anchors in one atomic batch.
    const sentenceOps = plan.sentences.map((s) => ({
      tokenLayerId: layerInfo.sentenceTokenLayer.id,
      text: textId,
      begin: s.begin,
      end: s.end,
      metadata: { [UMR_NAMESPACE]: s.meta },
    }));
    const wordOps = plan.sentences.flatMap((s) =>
      s.words.map((w) => ({
        tokenLayerId: layerInfo.wordTokenLayer.id,
        text: textId,
        begin: w.begin,
        end: w.end,
      })),
    );
    const pieceOps = plan.pieces.map((p) => ({
      tokenLayerId: layerInfo.nodeTokenLayer.id,
      text: textId,
      begin: p.begin,
      end: p.end,
    }));
    const tokenResults = await client.batched(async (b) => {
      b.tokens.bulkCreate(sentenceOps);
      if (wordOps.length) b.tokens.bulkCreate(wordOps);
      if (pieceOps.length) b.tokens.bulkCreate(pieceOps);
    });
    const pieceIds = pieceOps.length ? tokenResults.at(-1)?.body?.ids || [] : [];
    if (pieceIds.length !== pieceOps.length) {
      throw new Error(
        `The server returned ${pieceIds.length} anchor ids for ${pieceOps.length} anchors.`,
      );
    }

    // Nodes: one span per graph node and per constant in use.
    const spanOps = plan.nodes.map((n) => ({
      spanLayerId: layerInfo.conceptLayer.id,
      tokens: n.pieceIndexes.map((i) => pieceIds[i]),
      value: n.concept,
      metadata: { [UMR_NAMESPACE]: n.meta },
    }));
    let spanIds = [];
    if (spanOps.length) {
      const spanResults = await client.batched(async (b) => {
        b.spans.bulkCreate(spanOps);
      });
      spanIds = spanResults.at(-1)?.body?.ids || [];
    }
    if (spanIds.length !== spanOps.length) {
      throw new Error(
        `The server returned ${spanIds.length} node ids for ${spanOps.length} nodes.`,
      );
    }
    const spanOf = (key) => spanIds[plan.nodeIndex.get(key)];

    // Edges and triples: two layers, so two bulk creates in one batch.
    const edgeOps = plan.edges.map((e) => ({
      relationLayerId: layerInfo.relationLayer.id,
      source: spanOf(e.source),
      target: spanOf(e.target),
      value: e.role,
      metadata: { [UMR_NAMESPACE]: { order: e.order } },
    }));
    const tripleOps = plan.triples.map((t) => ({
      relationLayerId: layerInfo.documentGraphLayer.id,
      source: spanOf(t.source),
      target: spanOf(t.target),
      value: t.rel,
      metadata: { [UMR_NAMESPACE]: t.meta },
    }));
    if (edgeOps.length || tripleOps.length) {
      await client.batched(async (b) => {
        if (edgeOps.length) b.relations.bulkCreate(edgeOps);
        if (tripleOps.length) b.relations.bulkCreate(tripleOps);
      });
    }

    return { document: { id: documentId, name }, warnings };
  } catch (err) {
    if (documentId) {
      try {
        await client.documents.delete(documentId);
      } catch (delErr) {
        console.error('Failed to clean up the document after an import failure:', delErr);
        const wrapped = new Error(
          `${err.message} The partial document ${documentId} could not be deleted either.`,
        );
        wrapped.cause = err;
        throw wrapped;
      }
    }
    throw err;
  }
}

// Everything the writes need, computed before the first request so a file
// that cannot be imported costs no document. Node keys are `sentence:var`,
// constants are their own name. A sentence whose graph the parser could not
// read keeps its graph and alignment blocks as text on the sentence, so the
// export writes them back and nothing is lost; its document-level triples
// are read all the same.
export function planImport(parsedSentences, warnings = []) {
  let offset = 0;
  const bodyLines = [];
  const sentences = [];
  const pieces = [];
  const nodes = [];
  const nodeIndex = new Map();
  const edges = [];
  const triples = [];
  const tripleBySig = new Map();
  const varToKey = new Map();
  const pendingTriples = [];

  const addNode = (key, concept, meta, pieceIndexes) => {
    nodeIndex.set(key, nodes.length);
    nodes.push({ key, concept, meta, pieceIndexes });
  };
  const addPiece = (begin, end) => {
    pieces.push({ begin, end });
    return pieces.length - 1;
  };

  parsedSentences.forEach((ps, i) => {
    const index = i + 1;
    const line = ps.words.join(' ');
    const begin = offset;
    const words = [];
    let cursor = begin;
    ps.words.forEach((w, wi) => {
      const len = cpLength(w);
      words.push({ index: wi + 1, begin: cursor, end: cursor + len });
      cursor += len + 1;
    });
    // The sentence takes the newline after it, so the layer tiles the text.
    const end = begin + cpLength(line) + 1;
    bodyLines.push(line);
    offset = end;
    const meta = {
      snt: ps.snt ?? index,
      ilg: (ps.ilg || []).filter((l) => l.key !== 'index' && l.key !== 'words'),
      meta: ps.meta || [],
    };
    const sentenceText = (ps.sentenceText || '').trim();
    if (sentenceText && sentenceText !== line) meta.text = sentenceText;
    sentences.push({ index, begin, end, words, meta });

    const readable = ps.graph?.root && !ps.graph.errors?.length;
    if (ps.graph?.root && !readable) {
      meta.rawGraph = ps.raw?.graph || '';
      meta.rawAlignment = ps.raw?.alignment || '';
      warnings.push(
        `Sentence ${index}: the graph could not be read and is kept as text (${ps.graph.errors[0].message}).`,
      );
    }
    if (readable) {
      ps.graph.nodes.forEach((node, v) => {
        const ranges = ps.alignment?.get(v) || [];
        const pieceIndexes = [];
        ranges.forEach(([a, b]) => {
          const first = words[a - 1];
          const last = words[b - 1];
          if (!first || !last) {
            warnings.push(
              `Sentence ${index}: ${v} aligns to words ${a}-${b}, outside the sentence.`,
            );
            return;
          }
          pieceIndexes.push(addPiece(first.begin, last.end));
        });
        if (!pieceIndexes.length) pieceIndexes.push(addPiece(begin, begin));
        const attrs = [];
        node.children.forEach((child, order) => {
          if (child.kind === 'node') {
            edges.push({
              source: `${index}:${v}`,
              target: `${index}:${child.value}`,
              role: child.rel,
              order,
              sentence: index,
            });
          } else {
            attrs.push({ rel: child.rel, value: child.value, order });
          }
        });
        const key = `${index}:${v}`;
        varToKey.set(v, key);
        const meta = { var: v, attrs };
        // The file's root is data: a graph with a cycle no :quote explains
        // has no root by derivation, and the file says which node it is.
        if (v === ps.graph.root) meta.root = true;
        addNode(key, node.concept, meta, pieceIndexes);
      });
    }

    if (ps.docGraph) pendingTriples.push({ index, dg: ps.docGraph });
  });

  // Document-level triples, resolved once every sentence's nodes are known:
  // a file may name a node of a later sentence, and the export writes the
  // triple where the later of its two nodes lives.
  pendingTriples.forEach(({ index, dg }) => {
    const resolve = (name) => {
      if (DOC_CONSTANTS.includes(name)) {
        if (!nodeIndex.has(name))
          addNode(name, name, { var: name, constant: true }, [addPiece(0, 0)]);
        return name;
      }
      const key = varToKey.get(name);
      if (!key) {
        warnings.push(
          `Sentence ${index}: document-level triple names ${name}, which no sentence defines.`,
        );
      }
      return key || null;
    };
    ['temporal', 'modal', 'coref'].forEach((group) => {
      (dg[group] || []).forEach(([a, rel, b]) => {
        const source = resolve(a);
        const target = resolve(b);
        if (!source || !target) return;
        const sig = `${source} ${rel} ${target}`;
        const constantOnly = DOC_CONSTANTS.includes(a) && DOC_CONSTANTS.includes(b);
        const seen = tripleBySig.get(sig);
        if (seen) {
          // The same triple in several sentences is one relation; a triple
          // between two constants remembers every sentence that writes it.
          if (constantOnly && !seen.meta.sentences.includes(index)) seen.meta.sentences.push(index);
          return;
        }
        const meta = { group };
        if (constantOnly) meta.sentences = [index];
        const triple = { source, target, rel, meta };
        tripleBySig.set(sig, triple);
        triples.push(triple);
      });
    });
  });

  // An edge to a node the sentence never defined (a reference the parser
  // could not resolve) has nowhere to land.
  const kept = edges.filter((e) => {
    const ok = nodeIndex.has(e.source) && nodeIndex.has(e.target);
    if (!ok) {
      warnings.push(
        `Sentence ${e.sentence}: ${e.role} to ${e.target.split(':')[1]} dropped, no such node.`,
      );
    }
    return ok;
  });

  const empty = parsedSentences.filter((ps) => !ps.graph?.root).length;
  if (empty) warnings.push(`${count(empty, 'sentence has', 'sentences have')} no graph.`);

  return {
    body: bodyLines.join('\n') + '\n',
    sentences,
    pieces,
    nodes,
    nodeIndex,
    edges: kept.map(({ source, target, role, order }) => ({ source, target, role, order })),
    triples,
  };
}
