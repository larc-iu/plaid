// .umr import: text in, a new document in the project out.
//
// The text is the sentences' words joined by spaces, one sentence per line,
// since a .umr file carries tokens and not a text. Sentences tile the text
// (the sentence layer is partitioning), each taking the newline after it.
import { cpLength, createdIds } from '@larc-iu/plaid-client';
import { UMR_NAMESPACE, missingUmrLayerLabels, getUmrLayerInfo } from '../utils/umrLayerUtils.js';
import { parseUmrFile } from './format/umrFile.js';
import { nfc } from './format/penman.js';
import { DOC_CONSTANTS } from './format/inventory.js';
import { buildDocumentGraph, KEPT_VARIABLE, wordForFile } from './sentenceGraph.js';
import { createOnce } from '../../../plaid-ui/src/lib/createOnce.js';
import { pendingId } from '../../../plaid-ui/src/domain/pendingIds.js';
import { humanizeError } from '../../../plaid-ui/src/lib/errors.js';

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {object} client
 * @param {string} projectId
 * @param {string} name the document's name
 * @param {string} text the .umr file
 * @param {object} layerInfo from getUmrLayerInfo(project), configured
 * @param {object} [options] `into`: an existing document's id to annotate,
 *   whose words must match the file's sentence by sentence; it must hold no
 *   UMR nodes yet. `mint`: a `{ current }` holding the id the new document
 *   is created under, kept by the caller across attempts of the same import
 *   so a second cannot make a second document (createOnce.js)
 * @returns {Promise<{ document: { id: string, name: string }, warnings: string[], attached: boolean }>}
 */
export const importUmrDocument = (client, projectId, name, text, layerInfo, options = {}) =>
  client.withOperation(
    `Import UMR document "${name}"`,
    () => importDocument(client, projectId, name, text, layerInfo, options),
    IMPORT_KIND,
  );

// What an import is in the audit log, for a reader counting operations by
// kind. Core keeps what an import writes as the file has it, a cycle of
// relations included, where a person's write would be refused.
const IMPORT_KIND = { kind: 'import', ref: 'format:umr' };

async function importDocument(client, projectId, name, text, layerInfo, options) {
  if (!name || !name.trim()) throw new Error('Document name is required');
  if (!text || !text.trim()) throw new Error('No content to import');
  if (!layerInfo?.isConfigured) {
    console.error(
      'UMR layers missing:',
      missingUmrLayerLabels(layerInfo?.missingLayers).join(', '),
    );
    throw new Error('This project is not set up for UMR.');
  }

  const parsed = parseUmrFile(text);
  if (!parsed.sentences.length) {
    const first = parsed.errors?.[0];
    throw new Error(
      first ? `Failed to read the file: ${first.message}` : 'No sentences found in the file.',
    );
  }
  const warnings = [];

  // Onto an existing document: its words are the file's, sentence by sentence,
  // and nothing of the substrate is written.
  let existing = null;
  if (options.into) {
    const raw = await client.documents.get(options.into, true);
    const info = getUmrLayerInfo(raw);
    if (!info.isConfigured) throw new Error('The document is not set up for UMR.');
    const graph = buildDocumentGraph(info);
    if (standingOf(info, graph) === 'graph') throw new Error(hasGraph(raw.name));
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
      const created = await createOnce(options.mint ?? { current: null }, (id) =>
        client.documents.create(projectId, name, undefined, undefined, { id }),
      );
      documentId = created.id;
      const textResponse = await client.texts.create(layerInfo.textLayer.id, documentId, plan.body);
      textId = textResponse.id;
    }

    // Tokens: sentences, words, node anchors and the sentences' records in
    // one atomic batch. Onto an existing document, the anchors and records
    // alone: a sentence that has a record takes what the file said in it.
    const sentenceOps = existing
      ? []
      : plan.sentences.map((s) => ({
          tokenLayerId: layerInfo.sentenceTokenLayer.id,
          text: textId,
          begin: s.begin,
          end: s.end,
        }));
    // The triples between two constants under ids made here, so each
    // sentence's record can list the ones its block writes.
    const tripleIds = plan.triples.map(() => pendingId());
    const recordOf = (s) => {
      const listed = s.triples.map((ref) => (typeof ref === 'number' ? tripleIds[ref] : ref));
      return listed.length ? { ...s.meta, triples: listed } : s.meta;
    };
    const had = existing ? existing.graph.sentences : [];
    const recordOps = plan.sentences
      .filter((s) => !had[s.index - 1]?.recordToken)
      .map((s) => ({
        id: pendingId(),
        tokenLayerId: layerInfo.nodeTokenLayer.id,
        text: textId,
        begin: s.begin,
        end: s.end,
        metadata: { [UMR_NAMESPACE]: recordOf(s) },
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
      if (recordOps.length) b.tokens.bulkCreate(recordOps);
      plan.sentences.forEach((s) => {
        const record = had[s.index - 1]?.recordToken;
        if (record) {
          b.tokens.patchMetadata(record, [
            { op: 'set', path: [UMR_NAMESPACE], value: recordOf(s) },
          ]);
        }
      });
    });
    // The anchors' ids: after the sentence and word creates, before the
    // records.
    const pieceIndex = (sentenceOps.length ? 1 : 0) + (wordOps.length ? 1 : 0);
    const pieceIds = pieceOps.length ? createdIds(tokenResults[pieceIndex]) : [];
    createdTokenIds = [...pieceIds, ...(existing ? recordOps.map((r) => r.id) : [])];
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
      : createdIds(tokenResults[0]);
    // The words by their position in text order (planImport), for the
    // aligned nodes to record.
    const wordIds = existing
      ? plan.sentences.flatMap((s) => s.words.map((w) => w.id))
      : wordOps.length
        ? createdIds(tokenResults[sentenceOps.length ? 1 : 0])
        : [];
    if (!existing && wordIds.length !== wordOps.length) {
      throw new Error(
        `The server returned ${wordIds.length} word ids for ${wordOps.length} words.`,
      );
    }
    const metaOf = (n) => {
      if (n.home) return { ...n.meta, sentence: sentenceIds[n.home - 1] };
      return n.words.length ? { ...n.meta, words: n.words.map((k) => wordIds[k]) } : n.meta;
    };
    const toCreate = plan.nodes.filter((n) => !n.existingId);
    const spanOps = toCreate.map((n) => ({
      spanLayerId: layerInfo.conceptLayer.id,
      tokens: n.pieceIndexes.map((i) => pieceIds[i]),
      value: n.concept,
      metadata: { [UMR_NAMESPACE]: metaOf(n) },
    }));
    let spanIds = [];
    if (spanOps.length) {
      const spanResults = await client.batched(async (b) => {
        b.spans.bulkCreate(spanOps);
      });
      spanIds = createdIds(spanResults.at(-1));
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
    const tripleOps = plan.triples.map((t, i) => ({
      id: tripleIds[i],
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

    return {
      document: { id: documentId, name },
      warnings: [...warnings, ...readerNotes(parsed)],
      attached: !!existing,
    };
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
          `${humanizeError(err, 'Failed to import.')} The partial document “${name.trim()}” was not deleted. Delete it by hand.`,
        );
        wrapped.cause = err;
        throw wrapped;
      }
    }
    throw err;
  }
}

const hasGraph = (name) => `"${name}" already has a graph.`;

const standingOf = (info, graph) => {
  // Constants (author, root) are not a graph: a document whose only nodes
  // are those is as bare as one with none. A graph kept as text is one.
  if (graph.sentences.some((s) => s.nodes.length || typeof s.rawGraph === 'string')) {
    return 'graph';
  }
  return (info.wordTokenLayer?.tokens || []).length ? 'words' : 'empty';
};

/**
 * What an import of a file does with the project's document of the same
 * name (ruled 2026-09-28, umr-import-repeat-file), from that document read
 * with its body: `{ into }`, its id, when it has words and no graph, and the
 * file's graphs go onto its words; `{ into: null, note }` when it has no
 * words, and the file becomes a new document with that note. A document that
 * already has a graph (a node, or a graph kept as text) refuses: a repeated
 * import is the common accident. Words that differ are found by the import
 * itself (`importUmrDocument` with `into`), and also make a new document.
 *
 * @param {object} raw the document, from `documents.get(id, true)`
 * @returns {{into: string|null, note?: string}}
 */
export function importTarget(raw) {
  const info = getUmrLayerInfo(raw);
  const standing = info.isConfigured ? standingOf(info, buildDocumentGraph(info)) : 'empty';
  if (standing === 'graph') throw new Error(hasGraph(raw.name));
  if (standing === 'empty') return { into: null, note: `"${raw.name}" has no words.` };
  return { into: raw.id };
}

// Notes the reader makes once per node, said once per sentence instead: the
// Navajo sample has a space before the colon on every alignment line, and the
// report was a line per node.
const PER_SENTENCE = {
  'alignment-space-before-colon': 'Alignment lines have a space before the colon.',
  'legacy-unaligned': "Alignment '-1--1' is UMR 1.0 for unaligned.",
};

/**
 * What the reader noted about the file, as lines of the import report, after
 * the lines about what the import did. Each names its sentence, and a note
 * the reader made in many sentences (an obsolete header, a missing sentence
 * id) is one line with a count, so it does not bury the rest. A graph the
 * reader could not parse is left out: its sentence has its own "unreadable
 * graph" line (planImport).
 *
 * @param {{warnings?: Array, errors?: Array}} parsed what parseUmrFile returned
 * @returns {string[]}
 */
export function readerNotes(parsed) {
  const lines = [];
  const sentencesOf = new Map();
  const notes = [
    ...(parsed.warnings || []),
    ...(parsed.errors || []).filter((e) => e.code !== 'sentence-graph'),
  ];
  notes.forEach(({ code, message: said, sentence }) => {
    const message = PER_SENTENCE[code] ?? said;
    if (sentence == null) {
      if (!lines.includes(message)) lines.push(message);
      return;
    }
    if (!sentencesOf.has(message)) sentencesOf.set(message, []);
    const list = sentencesOf.get(message);
    if (!list.includes(sentence)) list.push(sentence);
  });
  sentencesOf.forEach((sentences, message) => {
    lines.push(
      sentences.length === 1
        ? `Sentence ${sentences[0]}: ${message}`
        : `${sentences.length} sentences: ${message}`,
    );
  });
  return lines;
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
      // In NFC, as the file is read: a document whose text has combining
      // accents still holds the file's words.
      const have = existing.sentences[i].words.map((w) => nfc(wordForFile(w)));
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
  // (see umrReconcile.js). `words` are the words an aligned node records
  // (planWordSplits), as positions among all the sentences' words in text
  // order, which is the order the import makes them in.
  const addNode = (
    key,
    concept,
    meta,
    pieceIndexes,
    existingId = null,
    home = null,
    words = [],
  ) => {
    nodeIndex.set(key, nodes.length);
    nodes.push({ key, concept, meta, pieceIndexes, existingId, home, words });
  };
  let wordCount = 0;
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

  // The triples between two constants the document already has, by name,
  // for a sentence's record to list when attaching.
  const existingConstantTriples = new Map();
  (existing?.constants || []).forEach((c) =>
    c.docOut.forEach((t) => {
      const target = existing.nodesById.get(t.target);
      if (target?.constant) existingConstantTriples.set(`${c.var} ${t.rel} ${target.var}`, t.id);
    }),
  );

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
      have.words.forEach((w) =>
        words.push({ index: w.index, begin: w.begin, end: w.end, at: wordCount++, id: w.id }),
      );
    } else {
      let cursor = begin;
      ps.words.forEach((w, wi) => {
        const len = cpLength(w);
        words.push({ index: wi + 1, begin: cursor, end: cursor + len, at: wordCount++ });
        cursor += len + 1;
      });
      // The sentence takes the newline after it, so the layer tiles the text.
      end = begin + cpLength(line) + 1;
      bodyLines.push(line);
      offset = end;
    }
    // A Sentence line is the sentence's text (parseUmrFile), which the
    // export writes back from the text, so it is not also kept as a line.
    const meta = {
      snt: ps.snt ?? index,
      ilg: (ps.ilg || []).filter((l) => !['index', 'words', 'sentence'].includes(l.key)),
      meta: ps.meta || [],
    };
    // The file's text where the body is only its words joined. Onto an
    // existing document the body is the text, and a copy stored beside it
    // would go stale at the next edit in IGT.
    const sentenceText = (ps.sentenceText || '').trim();
    if (!existing && sentenceText && sentenceText !== line) meta.text = sentenceText;
    // `triples`: the triples between two constants this sentence's block
    // writes, as indexes into the plan's triples or, attaching, the ids of
    // ones the document has. The import lists them in the sentence's record.
    sentences.push({ index, begin, end, words, meta, triples: [] });

    // Any graph with a parse error is kept as text, a graph whose root could
    // not be found too: `((s2d / ...` lost the whole sentence.
    const readable = ps.graph?.root && !ps.graph.errors?.length;
    if (ps.graph?.errors?.length) {
      meta.rawGraph = ps.raw?.graph || '';
      meta.rawAlignment = ps.raw?.alignment || '';
      warnings.push(
        `Sentence ${index}: unreadable graph, stored as text (${ps.graph.errors[0].message}).`,
      );
    }
    if (readable) {
      ps.graph.nodes.forEach((node, v) => {
        // The export names each sentence's document-level block `s<n>s0`,
        // and the editors refuse a node of that name (UmrDocument), so a
        // file's node of that name can clash with a block the export writes.
        const docGraphOf = /^s([0-9]+)s0$/.exec(v)?.[1];
        if (docGraphOf) {
          warnings.push(
            `Sentence ${index}: ${v} names the document graph of sentence ${Number(docGraphOf)}. Rename the node.`,
          );
        }
        const ranges = ps.alignment?.get(v) || [];
        const pieceIndexes = [];
        const aligned = [];
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
          words.slice(a - 1, b).forEach((w) => aligned.includes(w.at) || aligned.push(w.at));
        });
        // A node the file aligns to no word stands over its whole sentence,
        // which is what keeps it alive through an edit to the text around it
        // (UmrDocument.piecesFor). Its record is what says it is unaligned.
        const unaligned = !pieceIndexes.length;
        if (unaligned) pieceIndexes.push(addPiece(begin, end));
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
        addNode(key, node.concept, meta, pieceIndexes, null, unaligned ? index : null, aligned);
      });
    }

    if (ps.docGraph) pendingTriples.push({ index, dg: ps.docGraph });
  });

  // Document-level triples, resolved once every sentence's nodes are known:
  // a file may name a node of a later sentence, and the export writes the
  // triple where the later of its two nodes lives.
  //
  // One naming a node of a graph kept as text (it could not be read) has
  // nothing to point at yet. It is HELD, by name, on the sentence whose block
  // wrote it (`held` on its token), written back in that block on export,
  // and made a real relation when the graph is mended in Text mode (the
  // owner's ruling). It was dropped with "no node s37e", which the kept
  // graph did define. The variables a kept graph defines, by sentence:
  const keptVars = new Map();
  sentences.forEach((s) => {
    const raw = s.meta.rawGraph;
    if (typeof raw !== 'string') return;
    for (const m of raw.matchAll(KEPT_VARIABLE)) {
      if (!keptVars.has(m[1])) keptVars.set(m[1], s.index);
    }
  });
  // Per block sentence: how many it holds, and for which kept sentences.
  const heldBy = new Map();
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
      return varToKey.get(name) || null;
    };
    ['temporal', 'modal', 'coref'].forEach((group) => {
      (dg[group] || []).forEach(([a, rel, b]) => {
        const source = resolve(a);
        const target = resolve(b);
        if (!source || !target) {
          const missing = [...new Set([source ? null : a, target ? null : b])].filter(Boolean);
          if (missing.every((v) => keptVars.has(nfc(v)) || keptVars.has(v))) {
            const meta = sentences[index - 1].meta;
            (meta.held ||= []).push({ source: a, rel, target: b, group });
            const note = heldBy.get(index) || { count: 0, kept: new Set() };
            note.count += 1;
            missing.forEach((v) => note.kept.add(keptVars.get(nfc(v)) ?? keptVars.get(v)));
            heldBy.set(index, note);
            return;
          }
          warnings.push(
            `Sentence ${index}: (${a} ${rel} ${b}) dropped, no node ${missing.join(' or ')}.`,
          );
          return;
        }
        const sig = `${source} ${rel} ${target}`;
        // The same triple in several sentences is one relation. One between
        // two constants is listed in the record of every sentence that
        // writes it.
        const constantOnly = DOC_CONSTANTS.includes(a) && DOC_CONSTANTS.includes(b);
        const list = sentences[index - 1].triples;
        const listed = (ref) => {
          if (constantOnly && !list.includes(ref)) list.push(ref);
        };
        if (existingTriples.has(`${a} ${rel} ${b}`)) {
          const had = existingConstantTriples.get(`${a} ${rel} ${b}`);
          if (had) listed(had);
          return;
        }
        if (tripleBySig.has(sig)) {
          listed(tripleBySig.get(sig));
          return;
        }
        tripleBySig.set(sig, triples.length);
        listed(triples.length);
        triples.push({ source, target, rel, meta: { group } });
      });
    });
  });

  // Attaching, a sentence's record is replaced by what the file says of it,
  // and a triple between two constants is shown only where a record lists it.
  // One the record lists and the file leaves out stays listed: the document
  // has it, and dropping it from the list would leave it stored and shown
  // nowhere, exports included.
  if (existing) {
    const live = new Set(existingConstantTriples.values());
    (existing.records || []).forEach(({ sentence, own, record }) => {
      const list = own ? sentences[sentence - 1]?.triples : null;
      if (!list || !Array.isArray(record?.triples)) return;
      record.triples.forEach((id) => {
        if (live.has(id) && !list.includes(id)) list.push(id);
      });
    });
  }

  heldBy.forEach(({ count: n, kept }, index) => {
    const which = [...kept].sort((x, y) => x - y);
    const names =
      which.length === 1
        ? `sentence ${which[0]}`
        : `sentences ${which.slice(0, -1).join(', ')} and ${which.at(-1)}`;
    warnings.push(
      `Sentence ${index}: ${count(n, 'document-level relation is', 'document-level relations are')} held until ${names} ${which.length === 1 ? 'is' : 'are'} mended.`,
    );
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

  // A graph kept as text is not "no graph": it has its own line above.
  const empty = parsedSentences.filter((ps) => !ps.graph?.root && !ps.graph?.errors?.length).length;
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
