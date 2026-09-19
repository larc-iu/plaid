// Live round trip between Plaid IGT and Plaid UMR on one project, each app
// driven by its OWN code against the live core (:8085):
//
//   1. IGT's setup and FLEx import make a project from a slice of a real
//      corpus (FieldWorks' Lezgi export).
//   2. UMR adopts the project and annotates eight sentences through
//      UmrDocument: a root, a child, an unaligned child and a re-entrant
//      edge in each, a modality from `author`, a temporal relation to the
//      sentence before and a coreference to it.
//   3. IGT edits the substrate the way a person would, one edit per
//      sentence: respell a word, split a word, merge two words, split a
//      sentence, merge two sentences, delete a sentence's text.
//   4. UMR reads the document again, and each check says what survived.
//
// Run from plaid-umr, through IGT's module aliases:
//
//   node --import ../plaid-igt/e2e/live/aliases.mjs e2e/live/igt-roundtrip.mjs [--keep]
//
// It reads ~/Downloads/lezgi.flextext (not checked in). The project is
// deleted at the end unless --keep is given.

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import PlaidClient, { cpSlice, cpLength } from '@larc-iu/plaid-client';
import { parseFlextextFiles } from '../../../plaid-igt/src/import/flex/flextextParser.js';
import { buildDocuments } from '../../../plaid-igt/src/import/flex/buildDocuments.js';
import { deriveImportConfig, runImport } from '../../../plaid-igt/src/import/flex/importEngine.js';
import { executeProjectSetup } from '../../../plaid-igt/src/components/projects/setup/executeSetup.js';
import { IgtDocument } from '../../../plaid-igt/src/domain/IgtDocument.js';
import { UmrDocument } from '../../src/domain/UmrDocument.js';
import { adoptSubstrate } from '../../src/domain/umrProjectSetup.js';
import { getUmrLayerInfo } from '../../src/utils/umrLayerUtils.js';
import { parseUmrFile } from '../../src/domain/format/umrFile.js';

const KEEP = process.argv.includes('--keep');
const FILE = process.env.LEZGI || '/home/luke/Downloads/lezgi.flextext';
const SENTENCES = 8;

if (!existsSync(FILE)) {
  console.log(`skipped: ${FILE} is not here`);
  process.exit(0);
}

const failures = [];
const check = (cond, label, detail = '') => {
  console.log(`${cond ? '  ok ' : 'FAIL '} ${label}${cond ? '' : `   ${detail}`}`);
  if (!cond) failures.push(label);
};

const token = readFileSync(new URL('../../.token', import.meta.url), 'utf8').trim();
const client = new PlaidClient(process.env.PLAID_CORE_URL || 'http://localhost:8085', token);

// ---- 1. IGT makes the project ----------------------------------------------

const ir = parseFlextextFiles([{ name: basename(FILE), xml: readFileSync(FILE, 'utf8') }]);
// The first text, cut to the paragraphs that hold the first sentences.
const [first] = ir.texts;
const paragraphs = [];
let segments = 0;
for (const p of first.paragraphs) {
  if (segments >= SENTENCES) break;
  paragraphs.push(p);
  segments += p.segments.length;
}
ir.texts = [{ ...first, paragraphs }];
const build = buildDocuments(ir);
const config = deriveImportConfig(ir, build);

const setup = await executeProjectSetup({
  client,
  isNewProject: true,
  resumeProjectId: null,
  setupData: {
    basicInfo: { projectName: `igt-umr-roundtrip-${Date.now() % 1e7}` },
    orthographies: {
      orthographies: [
        { name: 'Baseline', isBaseline: true },
        ...config.orthographies.map((o) => ({ name: o.name })),
      ],
    },
    fields: {
      fields: config.fields.map((f) => ({
        name: f.name,
        scope: f.scope,
        lang: f.ws ?? null,
        isCustom: true,
      })),
      ignoredTokens: {
        mode: 'unicode-punctuation',
        unicodePunctuationExceptions: [],
        explicitIgnoredTokens: [],
      },
    },
    vocabulary: { vocabularies: [] },
    documentMetadata: {
      enabledFields: config.documentMetadata.map((m) => ({
        name: m.name,
        enabled: true,
        isCustom: true,
      })),
    },
  },
});
if (setup.failures.length) throw new Error(`setup failed: ${setup.failures.join('; ')}`);
const projectId = setup.projectId;

const cleanup = async () => {
  if (KEEP) console.log(`kept project ${projectId}`);
  else await client.projects.delete(projectId);
};

try {
  await runImport({
    operation: 'Import FLEx texts',
    client,
    projectId,
    build,
    lexicon: ir.lexicon,
    config,
    vocabId: null,
    shouldStop: null,
    onProgress: null,
  });
  const [{ id: documentId }] = await client.projects.listDocuments(projectId);

  // ---- 2. UMR adopts it and annotates ---------------------------------------

  let project = await client.projects.get(projectId);
  await adoptSubstrate(client, getUmrLayerInfo(project));
  project = await client.projects.get(projectId);
  const loadUmr = () => UmrDocument.load({ client, documentId, projectId, project });
  let umr = await loadUmr();
  check(umr.sentences.length >= SENTENCES, `UMR reads ${umr.sentences.length} sentences`);

  const byConcept = (doc, concept) =>
    [...doc.graph.nodesById.values()].find((n) => n.concept === concept) || null;
  // The words a node is anchored to, as text.
  const anchorText = (doc, node) => {
    const s = doc.sentence(node.sentence);
    return (s?.words || []).filter((w) => node.wordIds.includes(w.id)).map((w) => w.text);
  };
  const longestWord = (s) =>
    [...s.words]
      .filter((w) => /\p{L}/u.test(w.text))
      .sort((a, b) => b.text.length - a.text.length)[0];
  const letters = (s) => s.words.filter((w) => /\p{L}/u.test(w.text));

  for (let i = 1; i <= SENTENCES; i++) {
    const s = umr.sentence(i);
    const [w1, w2] = letters(s);
    // Sentence 2's root sits on its longest word, which IGT will split.
    const rootWord = i === 2 ? longestWord(s) : w1;
    const root = await umr.createNode({
      sentenceIndex: i,
      concept: `ev${i}-01`,
      wordIds: [rootWord.id],
    });
    await umr.createNode({
      sentenceIndex: i,
      concept: `thing${i}`,
      wordIds: [(w2 && w2.id !== rootWord.id ? w2 : w1).id],
      parentId: root.nodeId,
      role: ':ARG0',
    });
    await umr.createNode({
      sentenceIndex: i,
      concept: `person${i}`,
      parentId: root.nodeId,
      role: ':ARG1',
    });
    await umr.createEdge(byConcept(umr, `thing${i}`).id, byConcept(umr, `person${i}`).id, ':mod');
    await umr.createTriple({
      source: 'author',
      target: root.nodeId,
      rel: ':full-affirmative',
      group: 'modal',
      sentenceIndex: i,
    });
    if (i > 1) {
      await umr.createTriple({
        source: root.nodeId,
        target: byConcept(umr, `ev${i - 1}-01`).id,
        rel: ':after',
        group: 'temporal',
        sentenceIndex: i,
      });
      await umr.createTriple({
        source: byConcept(umr, `person${i}`).id,
        target: byConcept(umr, `person${i - 1}`).id,
        rel: ':same-entity',
        group: 'coref',
        sentenceIndex: i,
      });
    }
  }
  umr = await loadUmr();
  const before = {
    nodes: umr.graph.nodesById.size,
    edges: umr.sentences.reduce((n, s) => n + s.edges.length, 0),
    triples: umr.sentences.reduce((n, s) => n + s.triples.length, 0),
  };
  console.log('annotated:', JSON.stringify(before));
  const anchorsBefore = new Map(
    [...umr.graph.nodesById.values()]
      .filter((n) => !n.constant)
      .map((n) => [n.concept, anchorText(umr, n)]),
  );

  // ---- 3. IGT edits the substrate, last sentence first ----------------------

  const loadIgt = () => IgtDocument.load(client, projectId, documentId);
  let igt = await loadIgt();
  const sentenceIds = [...igt.layerInfo.sentenceTokenLayer.tokens]
    .sort((a, b) => a.begin - b.begin)
    .map((t) => t.id);
  const tokenOf = (doc, layer, id) => doc.layerInfo[layer].tokens.find((t) => t.id === id);
  const wordsIn = (doc, sentenceId) => {
    const s = tokenOf(doc, 'sentenceTokenLayer', sentenceId);
    return doc.layerInfo.primaryTokenLayer.tokens
      .filter((w) => w.begin >= s.begin && w.end <= s.end)
      .sort((a, b) => a.begin - b.begin);
  };
  const bodyOf = (doc) => doc.layerInfo.primaryTextLayer.text.body;
  const said = (ok, what) => {
    if (!ok) throw new Error(`IGT refused: ${what} (${igt.error || 'no message'})`);
  };

  // Sentence 7: its text deleted.
  {
    const s = tokenOf(igt, 'sentenceTokenLayer', sentenceIds[6]);
    const body = bodyOf(igt);
    said(
      await igt.saveBaselineText(cpSlice(body, 0, s.begin) + cpSlice(body, s.end, cpLength(body))),
      'delete sentence 7',
    );
    igt = await loadIgt();
  }
  // Sentences 5 and 6: merged.
  said(await igt.mergeSentence(sentenceIds[5]), 'merge sentence 6 into 5');
  igt = await loadIgt();
  // Sentence 4: split before its second lettered word.
  {
    const ws = wordsIn(igt, sentenceIds[3]).filter((w) =>
      /\p{L}/u.test(cpSlice(bodyOf(igt), w.begin, w.end)),
    );
    said(await igt.splitSentence(ws[1].begin), 'split sentence 4');
    igt = await loadIgt();
  }
  // Sentence 3: its first two words merged.
  {
    const ws = wordsIn(igt, sentenceIds[2]);
    said(await igt.mergeTokens([ws[0].id, ws[1].id]), 'merge two words of sentence 3');
    igt = await loadIgt();
  }
  // Sentence 2: its longest word split after its second character.
  {
    const body = bodyOf(igt);
    const w = wordsIn(igt, sentenceIds[1])
      .map((t) => ({ t, text: cpSlice(body, t.begin, t.end) }))
      .sort((a, b) => cpLength(b.text) - cpLength(a.text))[0];
    said(await igt.splitToken(w.t.id, 1), 'split a word of sentence 2');
    igt = await loadIgt();
  }
  // Sentence 1: its second lettered word respelled, one character changed,
  // through the text editor's path (the whole body saved).
  let respelled = null;
  {
    const body = bodyOf(igt);
    const w = wordsIn(igt, sentenceIds[0]).filter((t) =>
      /\p{L}/u.test(cpSlice(body, t.begin, t.end)),
    )[1];
    const old = cpSlice(body, w.begin, w.end);
    respelled = `${cpSlice(old, 0, cpLength(old) - 1)}ь`;
    said(
      await igt.saveBaselineText(
        cpSlice(body, 0, w.begin) + respelled + cpSlice(body, w.end, cpLength(body)),
      ),
      'respell a word of sentence 1',
    );
    console.log(`respelled "${old}" as "${respelled}"`);
  }

  // ---- 4. UMR reads it again ------------------------------------------------

  // Opening it heals first, as the editor does (reconcile-on-open).
  umr = await loadUmr();
  const healed = await umr.reconcileOnOpen();
  check(!healed.error, 'the repair on open ran', String(healed.error));
  console.log(`   repair: ${umr.describeReconcile(healed) || 'nothing to do'}`);
  umr = await loadUmr();
  const nodes = [...umr.graph.nodesById.values()].filter((n) => !n.constant);
  const node = (c) => byConcept(umr, c);
  const edgesOf = (c) => {
    const n = node(c);
    return n
      ? [...n.out.map((e) => `out ${e.role}`), ...n.in.map((e) => `in ${e.role}`)].sort()
      : null;
  };
  const sentenceOfNode = (c) => node(c)?.sentence ?? null;
  console.log(
    'after:',
    JSON.stringify({
      sentences: umr.sentences.length,
      nodes: umr.graph.nodesById.size,
      edges: umr.sentences.reduce((n, s) => n + s.edges.length, 0),
      triples: umr.sentences.reduce((n, s) => n + s.triples.length, 0),
    }),
  );
  for (const n of nodes) {
    console.log(
      `   ${n.concept.padEnd(10)} s${n.sentence ?? '?'}  anchor ${JSON.stringify(anchorText(umr, n))}` +
        `  was ${JSON.stringify(anchorsBefore.get(n.concept))}  edges ${JSON.stringify(edgesOf(n.concept))}`,
    );
  }

  // Sentence 1, respelled.
  check(!!node('thing1'), 'the node on the respelled word survives');
  check(
    JSON.stringify(anchorText(umr, node('thing1') || { wordIds: [], sentence: 1 })) ===
      JSON.stringify([respelled]),
    'and is anchored to the new spelling',
    JSON.stringify(anchorText(umr, node('thing1') || { wordIds: [], sentence: 1 })),
  );
  // Sentence 2, a word split.
  check(
    !!node('ev2-01') && anchorText(umr, node('ev2-01')).length === 2,
    'the root on the split word covers both halves',
    JSON.stringify(node('ev2-01') && anchorText(umr, node('ev2-01'))),
  );
  // Sentence 3, two words merged.
  check(['ev3-01', 'thing3', 'person3'].every(node), 'the nodes on merged words survive');
  // Sentence 4, split: everything survives, wherever it now sits.
  check(['ev4-01', 'thing4', 'person4'].every(node), 'a split sentence keeps its nodes');
  check(
    JSON.stringify(edgesOf('thing4')) === JSON.stringify(['in :ARG0', 'out :mod']),
    'and its edges',
    JSON.stringify(edgesOf('thing4')),
  );
  console.log(
    `   sentence 4's nodes now in: ${['ev4-01', 'thing4', 'person4'].map(sentenceOfNode).join(', ')}`,
  );
  // An edge the split left between the halves is not silent: the export
  // leaves it out, and says so on the node it leaves.
  const across = umr.problems.filter((p) => p.code === 'edge-across-sentences');
  if (sentenceOfNode('ev4-01') !== sentenceOfNode('thing4')) {
    check(
      across.some((p) => p.var === node('ev4-01').var),
      'an edge the split left between two sentences is reported',
      JSON.stringify(across),
    );
  }
  // Sentences 5 and 6, merged.
  check(
    ['ev5-01', 'thing5', 'person5', 'ev6-01', 'thing6', 'person6'].every(node) &&
      sentenceOfNode('ev5-01') === sentenceOfNode('ev6-01'),
    'two merged sentences keep both graphs, in one sentence',
  );
  // The merged-away sentence's unaligned node is bound to the one it joined.
  const merged = umr.sentence(sentenceOfNode('ev5-01'));
  check(
    node('person6')?.metadata?.umr?.sentence === merged?.tokenId,
    "the merged sentence's unaligned node records the sentence it joined",
    JSON.stringify(node('person6')?.metadata?.umr),
  );
  // Sentence 7, deleted.
  check(!node('ev7-01') && !node('thing7'), "a deleted sentence's anchored nodes go with it");
  check(
    !node('person7'),
    'and so does its unaligned node',
    `person7 is in sentence ${sentenceOfNode('person7')}`,
  );
  // Sentence 8, untouched.
  check(
    ['ev8-01', 'thing8', 'person8'].every(node) &&
      JSON.stringify(edgesOf('ev8-01')) === JSON.stringify(['out :ARG0', 'out :ARG1']),
    'an untouched sentence is untouched',
  );
  const eight = umr.sentences.find((s) => s.nodes.some((n) => n.concept === 'ev8-01'));
  check(
    eight && eight.nodes.every((n) => /8/.test(n.concept)),
    'and holds nothing of another sentence',
    eight ? eight.nodes.map((n) => n.concept).join(', ') : '',
  );
  // The constants, and the file.
  check(!!umr.constantNode('author'), 'the constants survive');
  const reparsed = parseUmrFile(umr.toUmr());
  check(
    reparsed.errors.length === 0,
    'the export parses',
    JSON.stringify(reparsed.errors.slice(0, 3)),
  );
  const codes = [...new Set(umr.problems.map((p) => p.code))];
  console.log(
    `   validation after the edits: ${umr.problems.length} problems (${codes.join(', ')})`,
  );
} finally {
  await cleanup();
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
