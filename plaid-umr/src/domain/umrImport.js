// .umr import: text in, a new document in the project out.
//
// The text is the sentences' words joined by spaces, one sentence per line,
// since a .umr file carries tokens and not a text. Sentences tile the text
// (the sentence layer is partitioning), each taking the newline after it.
import { cpLength } from '@larc-iu/plaid-client';
import { UMR_NAMESPACE, missingUmrLayerLabels, getUmrLayerInfo } from '../utils/umrLayerUtils.js';
import { parseUmrFile } from './format/umrFile.js';
import { DOC_CONSTANTS } from './format/inventory.js';
import { buildDocumentGraph, wordForFile } from './sentenceGraph.js';

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {object} client
 * @param {string} projectId
 * @param {string} name the document's name
 * @param {string} text the .umr file
 * @param {object} layerInfo from getUmrLayerInfo(project), configured
 * @param {object} [options] `into`: an existing document's id to annotate,
 *   whose words must match the file's sentence by sentence; it must hold no
 *   UMR nodes yet
 * @returns {Promise<{ document: { id: string, name: string }, warnings: string[], attached: boolean }>}
 */
export async function importUmrDocument(client, projectId, name, text, layerInfo, options = {}) {
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

  // Onto an existing document: its words are the file's, sentence by sentence,
  // and nothing of the substrate is written.
  let existing = null;
  if (options.into) {
    const raw = await client.documents.get(options.into, true);
    const info = getUmrLayerInfo(raw);
    if (!info.isConfigured) throw new Error('The document is not set up for UMR.');
    const graph = buildDocumentGraph(info);
    // Constants (author, root) are not a graph: a document whose only nodes
    // are those is as bare as one with none.
    if (graph.sentences.some((s) => s.nodes.length)) {
      throw new Error(
        `"${raw.name}" already holds UMR nodes. Delete them first, or import as a new document.`,
      );
    }
    existing = { raw, info, graph };
  }

  const plan = planImport(parsed.sentences, warnings, existing ? { existing: existing.graph } : {});
  // What an attach makes, for the rollback below: the anchors, whose
  // deletion cascades to the spans and relations made on them.
  let createdTokenIds = [];

  let documentId = existing ? existing.raw.id : null;
  try {
    let textId;
    if (existing) {
      textId = existing.info.textLayer.text.id;
    } else {
      const created = await client.documents.create(projectId, name);
      documentId = created.id;
      const textResponse = await client.texts.create(layerInfo.textLayer.id, documentId, plan.body);
      textId = textResponse.id;
    }

    // Tokens: sentences, words and node anchors in one atomic batch. Onto an
    // existing document, the anchors alone, and the sentences take what the
    // file said about them.
    const sentenceOps = existing
      ? []
      : plan.sentences.map((s) => ({
          tokenLayerId: layerInfo.sentenceTokenLayer.id,
          text: textId,
          begin: s.begin,
          end: s.end,
          metadata: { [UMR_NAMESPACE]: s.meta },
        }));
    const wordOps = existing
      ? []
      : plan.sentences.flatMap((s) =>
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
      if (sentenceOps.length) b.tokens.bulkCreate(sentenceOps);
      if (wordOps.length) b.tokens.bulkCreate(wordOps);
      if (pieceOps.length) b.tokens.bulkCreate(pieceOps);
      if (existing) {
        plan.sentences.forEach((s) => {
          const token = existing.graph.sentences[s.index - 1];
          if (token) b.tokens.patchMetadata(token.tokenId, { [UMR_NAMESPACE]: s.meta });
        });
      }
    });
    // The anchors' ids: after the sentence and word creates, before any
    // sentence metadata patches.
    const pieceIndex = (sentenceOps.length ? 1 : 0) + (wordOps.length ? 1 : 0);
    const pieceIds = pieceOps.length ? tokenResults[pieceIndex]?.body?.ids || [] : [];
    createdTokenIds = pieceIds;
    if (pieceIds.length !== pieceOps.length) {
      throw new Error(
        `The server returned ${pieceIds.length} anchor ids for ${pieceOps.length} anchors.`,
      );
    }

    // Nodes: one span per graph node and per constant in use. A constant the
    // document already has (an attach onto one with triples) is reused.
    // The sentence tokens by number, for the unaligned nodes to record.
    const sentenceIds = existing
      ? existing.graph.sentences.map((s) => s.tokenId)
      : tokenResults[0]?.body?.ids || [];
    const toCreate = plan.nodes.filter((n) => !n.existingId);
    const spanOps = toCreate.map((n) => ({
      spanLayerId: layerInfo.conceptLayer.id,
      tokens: n.pieceIndexes.map((i) => pieceIds[i]),
      value: n.concept,
      metadata: {
        [UMR_NAMESPACE]: n.home ? { ...n.meta, sentence: sentenceIds[n.home - 1] } : n.meta,
      },
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
    const createdIndex = new Map(toCreate.map((n, i) => [n.key, i]));
    const spanOf = (key) => {
      const node = plan.nodes[plan.nodeIndex.get(key)];
      return node?.existingId || spanIds[createdIndex.get(key)];
    };

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

    return { document: { id: documentId, name }, warnings, attached: !!existing };
  } catch (err) {
    if (existing && createdTokenIds.length) {
      // Take back what this run put on the document, so a retry is possible.
      try {
        await client.tokens.bulkDelete(createdTokenIds);
      } catch (delErr) {
        console.error('Failed to take back the anchors after an attach failure:', delErr);
      }
    }
    if (documentId && !existing) {
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
export function planImport(parsedSentences, warnings = [], { existing = null } = {}) {
  if (existing) {
    if (existing.sentences.length !== parsedSentences.length) {
      throw new Error(
        `The file has ${parsedSentences.length} sentences and the document ${existing.sentences.length}.`,
      );
    }
    parsedSentences.forEach((ps, i) => {
      // Word by word, as the export writes them: joined, the words of a
      // document with a merged word ("in order") matched a file that split
      // it, and every anchor after it landed one word late.
      const have = existing.sentences[i].words.map(wordForFile);
      if (have.length !== ps.words.length || have.some((w, k) => w !== ps.words[k])) {
        throw new Error(
          `Sentence ${i + 1} differs: the file has "${ps.words.join(' ')}", the document "${have.join(' ')}".`,
        );
      }
    });
  }
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

  // `home` is the sentence an UNALIGNED node belongs to, by number: its
  // anchor is a point, so it records its sentence's token once that exists
  // (see umrReconcile.js).
  const addNode = (key, concept, meta, pieceIndexes, existingId = null, home = null) => {
    nodeIndex.set(key, nodes.length);
    nodes.push({ key, concept, meta, pieceIndexes, existingId, home });
  };
  // Constants the document already has, and the triples it already holds
  // (by the variables' names), when attaching.
  const existingConstants = new Map((existing?.constants || []).map((c) => [c.var, c.id]));
  const existingTriples = new Set(
    (existing?.sentences || []).flatMap((s) =>
      s.triples.map((t) => {
        const name = (id) => existing.nodesById.get(id)?.var;
        return `${name(t.source)} ${t.rel} ${name(t.target)}`;
      }),
    ),
  );
  const addPiece = (begin, end) => {
    pieces.push({ begin, end });
    return pieces.length - 1;
  };

  parsedSentences.forEach((ps, i) => {
    const index = i + 1;
    const line = ps.words.join(' ');
    let begin = offset;
    let end;
    const words = [];
    if (existing) {
      const have = existing.sentences[i];
      begin = have.begin;
      end = have.end;
      have.words.forEach((w) => words.push({ index: w.index, begin: w.begin, end: w.end }));
    } else {
      let cursor = begin;
      ps.words.forEach((w, wi) => {
        const len = cpLength(w);
        words.push({ index: wi + 1, begin: cursor, end: cursor + len });
        cursor += len + 1;
      });
      // The sentence takes the newline after it, so the layer tiles the text.
      end = begin + cpLength(line) + 1;
      bodyLines.push(line);
      offset = end;
    }
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
          // A range written backwards made a token that ends before it
          // begins, and the whole import failed on it.
          if (a > b) {
            warnings.push(`Sentence ${index}: ${v} aligns to words ${a}-${b}, a range backwards.`);
            return;
          }
          pieceIndexes.push(addPiece(first.begin, last.end));
        });
        const unaligned = !pieceIndexes.length;
        if (unaligned) pieceIndexes.push(addPiece(begin, begin));
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
        addNode(key, node.concept, meta, pieceIndexes, null, unaligned ? index : null);
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
        if (!nodeIndex.has(name)) {
          const had = existingConstants.get(name);
          if (had) addNode(name, name, { var: name, constant: true }, [], had);
          else addNode(name, name, { var: name, constant: true }, [addPiece(0, 0)]);
        }
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
        if (existingTriples.has(`${a} ${rel} ${b}`)) return;
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
