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
  if (parsed.errors?.length) {
    const first = parsed.errors[0];
    throw new Error(
      `The file could not be read: ${first.message}${first.line ? ` (line ${first.line})` : ''}`,
    );
  }
  if (!parsed.sentences.length) throw new Error('No sentences found in the file');
  const warnings = [...(parsed.warnings || []).map((w) => (typeof w === 'string' ? w : w.message))];

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
    const spanResults = await client.batched(async (b) => {
      b.spans.bulkCreate(spanOps);
    });
    const spanIds = spanResults.at(-1)?.body?.ids || [];
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
// constants are their own name.
export function planImport(parsedSentences, warnings = []) {
  let offset = 0;
  const bodyLines = [];
  const sentences = [];
  const pieces = [];
  const nodes = [];
  const nodeIndex = new Map();
  const edges = [];
  const triples = [];
  const seenTriples = new Set();
  const constantsInUse = new Map();
  const varToKey = new Map();

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
    sentences.push({ index, begin, end, words, meta });

    if (!ps.graph?.root) return;
    ps.graph.nodes.forEach((node, v) => {
      const ranges = ps.alignment?.get(v) || [];
      const pieceIndexes = [];
      ranges.forEach(([a, b]) => {
        const first = words[a - 1];
        const last = words[b - 1];
        if (!first || !last) {
          warnings.push(`Sentence ${index}: ${v} aligns to words ${a}-${b}, outside the sentence.`);
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
          });
        } else {
          attrs.push({ rel: child.rel, value: child.value, order });
        }
      });
      const key = `${index}:${v}`;
      varToKey.set(v, key);
      addNode(key, node.concept, { var: v, attrs }, pieceIndexes);
    });

    const dg = ps.docGraph;
    if (!dg) return;
    const resolve = (name) => {
      if (DOC_CONSTANTS.includes(name)) {
        if (!constantsInUse.has(name)) {
          constantsInUse.set(name, true);
          addNode(name, name, { var: name, constant: true }, [addPiece(0, 0)]);
        }
        return name;
      }
      const key = varToKey.get(name);
      if (!key)
        warnings.push(
          `Sentence ${index}: document-level triple names ${name}, which no sentence defines.`,
        );
      return key || null;
    };
    ['temporal', 'modal', 'coref'].forEach((group) => {
      (dg[group] || []).forEach(([a, rel, b]) => {
        const source = resolve(a);
        const target = resolve(b);
        if (!source || !target) return;
        const sig = `${source} ${rel} ${target}`;
        if (seenTriples.has(sig)) return;
        seenTriples.add(sig);
        triples.push({ source, target, rel });
      });
    });
  });

  const dropped = parsedSentences.filter((ps) => !ps.graph?.root).length;
  if (dropped) warnings.push(`${count(dropped, 'sentence has', 'sentences have')} no graph.`);

  return {
    body: bodyLines.join('\n') + '\n',
    sentences,
    pieces,
    nodes,
    nodeIndex,
    edges,
    triples,
  };
}
