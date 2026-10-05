// The editor's optimistic mirror of the server's cascades, checked on a
// private core.
//
//   node --import ./e2e/live/aliases.mjs e2e/fidelity/mirror.mjs [--keep]
//
// Every reshaping mutation shows its result before the server answers, so
// the editor keeps its own copy of what core's cascades and layer rules do:
// a word deleted takes its morphemes, a merge joins two values of one field,
// a split cuts the relations a layer keeps inside one sentence. The unit
// tests run these on a fake client that records writes and applies none, so
// a mirror that differs from the server passed them all. Here each mutation
// runs on a real core over a document holding a person's work in igt's
// layers and in another app's (a nested layer kept coextensive with the
// words, a tree on it, and a graph whose edges stay inside one sentence),
// and two things are checked:
//
//   - the editor's document after the write settles holds what a fresh read
//     holds, on igt's layers (another app's layers are not the editor's to
//     mirror, and a span left with none of its tokens is never shown);
//   - the question the editor asks before a delete, split or merge counts
//     what the server then deleted.
//
// It found a sentence merge that left both translations on screen while the
// server joined them, so the next edit wrote over the second (D7-FAKES).
//
// Set PLAID_FIDELITY_CORE_URL and PLAID_FIDELITY_TOKEN to run against a core
// already started with `node e2e/fidelity/core.mjs` (see core.mjs).

import { PLAID_NAMESPACE } from '@larc-iu/plaid-client';
import { executeProjectSetup } from '../../src/components/projects/setup/executeSetup.js';
import { IgtDocument } from '../../src/domain/IgtDocument.js';
import {
  countAnnotationLossForWord,
  countSplitWordLoss,
  countSubWordAnnotationLoss,
} from '../../src/domain/annotationLoss.js';
import { coreForRun } from './core.mjs';

const BODY = 'Ali saw the fish today\nThe fish swam away quickly\nNobody followed them';

async function setUp(client) {
  const setup = await executeProjectSetup({
    client,
    isNewProject: true,
    resumeProjectId: null,
    setupData: {
      basicInfo: { projectName: `Mirror ${Date.now() % 1e6}` },
      orthographies: { orthographies: [{ name: 'Baseline', isBaseline: true }] },
      fields: {
        fields: [
          { name: 'Translation', scope: 'Sentence' },
          { name: 'Note', scope: 'Sentence' },
          { name: 'Gloss', scope: 'Word' },
          { name: 'Gloss', scope: 'Morpheme' },
        ],
      },
      vocabulary: {
        vocabularies: [{ id: 'new-lexicon', name: 'Lexicon', enabled: true, isCustom: true }],
      },
    },
  });
  if (setup.failures.length) throw new Error(`setup: ${setup.failures.join('; ')}`);
  const projectId = setup.projectId;
  let project = await client.projects.get(projectId);
  const text = project.textLayers.find((l) => l.config?.plaid?.role === 'baseline');
  const byRole = (role) => text.tokenLayers.find((l) => l.config?.plaid?.role === role);
  // Another app's layers, as a tree and a graph would lay them out.
  const words = await client.tokenLayers.create(text.id, 'Words', 'any', byRole('word').id);
  await client.tokenLayers.setConfig(words.id, PLAID_NAMESPACE, 'role', 'syntactic-word');
  await client.tokenLayers.setConstraints(words.id, 'other', [{ type: 'coextensive' }]);
  await client.tokenLayers.setConfig(byRole('word').id, PLAID_NAMESPACE, 'splitOnSpace', true);
  const lemma = await client.spanLayers.create(words.id, 'Lemma');
  const tree = await client.relationLayers.create(lemma.id, 'Tree');
  const inSentence = [{ type: 'same-ancestor', tokenLayer: byRole('sentence').id }];
  await client.relationLayers.setConstraints(tree.id, 'other', inSentence);
  const nodes = await client.tokenLayers.create(text.id, 'Nodes', 'any');
  const concepts = await client.spanLayers.create(nodes.id, 'Concepts');
  const edges = await client.relationLayers.create(concepts.id, 'Edges');
  await client.relationLayers.setConstraints(edges.id, 'other', inSentence);
  project = await client.projects.get(projectId);
  return { projectId, project, other: { words, lemma, tree, nodes, concepts, edges } };
}

// A document over BODY with a person's work on every layer.
async function makeDocument(client, { projectId, project, other }, name) {
  const text = project.textLayers.find((l) => l.config?.plaid?.role === 'baseline');
  const byRole = (role) => text.tokenLayers.find((l) => l.config?.plaid?.role === role);
  const field = (role, name) => byRole(role).spanLayers.find((l) => l.name === name).id;
  const vocabId = project.vocabs[0].id;
  const doc = await client.documents.create(projectId, name);
  const t = await client.texts.create(text.id, doc.id, BODY);
  const cps = [...BODY];
  const sentences = [];
  let b = 0;
  cps.forEach((ch, i) => {
    if (ch === '\n') (sentences.push([b, i + 1]), (b = i + 1));
  });
  sentences.push([b, cps.length]);
  const words = [...BODY.matchAll(/\S+/gu)].map((m) => [m.index, m.index + m[0].length]);
  const ids = (r) => r.ids;
  const sentIds = ids(
    await client.tokens.bulkCreate(
      sentences.map(([s, e]) => ({
        tokenLayerId: byRole('sentence').id,
        text: t.id,
        begin: s,
        end: e,
      })),
    ),
  );
  const wordIds = ids(
    await client.tokens.bulkCreate(
      words.map(([s, e]) => ({ tokenLayerId: byRole('word').id, text: t.id, begin: s, end: e })),
    ),
  );
  const at = (i) => cps.slice(...words[i]).join('');
  await client.batched(async (bt) => {
    sentIds.forEach((id, i) => {
      bt.spans.create(field('sentence', 'Translation'), [id], `translation ${i}`);
      bt.spans.create(field('sentence', 'Note'), [id], `note ${i}`);
    });
    wordIds.forEach((id, i) => bt.spans.create(field('word', 'Gloss'), [id], `G.${at(i)}`));
  });
  // Two morphemes on each word of four letters or more, glossed and linked.
  const long = words.map((w, i) => i).filter((i) => at(i).length >= 4);
  const morphIds = ids(
    await client.tokens.bulkCreate(
      long.flatMap((i) =>
        [at(i).slice(0, 2), at(i).slice(2)].map((form, k) => ({
          tokenLayerId: byRole('morpheme').id,
          text: t.id,
          begin: words[i][0],
          end: words[i][1],
          precedence: k + 1,
          metadata: { form },
        })),
      ),
    ),
  );
  const item = await client.vocabItems.create(vocabId, 'm');
  await client.batched(async (bt) => {
    morphIds.forEach((id) => {
      bt.spans.create(field('morpheme', 'Gloss'), [id], 'm.G');
      bt.vocabLinks.create(item.id, [id]);
    });
  });
  // The other app: a token per word with a lemma and a tree in each sentence,
  // and a node on each sentence's first and last word with an edge between.
  const swIds = ids(
    await client.tokens.bulkCreate(
      words.map(([s, e]) => ({ tokenLayerId: other.words.id, text: t.id, begin: s, end: e })),
    ),
  );
  const lemmaIds = ids(
    await client.spans.bulkCreate(
      swIds.map((id, i) => ({ spanLayerId: other.lemma.id, tokens: [id], value: at(i) })),
    ),
  );
  const inSentence = (i) => sentences.findIndex(([s, e]) => s <= words[i][0] && words[i][0] < e);
  const ofSentence = (k) => words.map((w, i) => i).filter((i) => inSentence(i) === k);
  const treeOps = [];
  const nodeOps = [];
  sentences.forEach((s, k) => {
    const ws = ofSentence(k);
    treeOps.push(...ws.slice(1).map((i) => [lemmaIds[ws[0]], lemmaIds[i]]));
    nodeOps.push(ws[0], ws.at(-1));
  });
  await client.relations.bulkCreate(
    treeOps.map(([source, target]) => ({
      relationLayerId: other.tree.id,
      source,
      target,
      value: 'dep',
    })),
  );
  const nodeIds = ids(
    await client.tokens.bulkCreate(
      nodeOps.map((i) => ({
        tokenLayerId: other.nodes.id,
        text: t.id,
        begin: words[i][0],
        end: words[i][1],
      })),
    ),
  );
  const conceptIds = ids(
    await client.spans.bulkCreate(
      nodeIds.map((id, n) => ({ spanLayerId: other.concepts.id, tokens: [id], value: `c${n}` })),
    ),
  );
  await client.relations.bulkCreate(
    sentences.map((s, k) => ({
      relationLayerId: other.edges.id,
      source: conceptIds[2 * k],
      target: conceptIds[2 * k + 1],
      value: ':ARG0',
    })),
  );
  return doc.id;
}

// Every entity of a document read, by id: kind, layer and what it says.
function entities(raw, keepLayer = () => true) {
  const out = new Map();
  for (const tl of raw.textLayers || []) {
    for (const kl of tl.tokenLayers || []) {
      if (!keepLayer(kl)) continue;
      const live = new Set((kl.tokens || []).map((t) => t.id));
      for (const t of kl.tokens || []) {
        out.set(t.id, { kind: 'token', layer: kl.name, v: `${t.begin}-${t.end}` });
      }
      for (const sl of kl.spanLayers || []) {
        for (const s of sl.spans || []) {
          // A span left with none of its tokens is never shown.
          if (!(s.tokens || []).some((id) => live.has(id))) continue;
          out.set(s.id, { kind: 'span', layer: `${kl.name}/${sl.name}`, v: `${s.value}` });
        }
        for (const rl of sl.relationLayers || []) {
          for (const r of rl.relations || []) {
            out.set(r.id, { kind: 'relation', layer: rl.name, v: `${r.source}>${r.target}` });
          }
        }
      }
    }
  }
  return out;
}

const igtLayer = (kl) =>
  ['sentence', 'word', 'morpheme', 'time-alignment'].includes(kl.config?.plaid?.role);

// The links a document read holds, and those the editor holds on a token it
// still has.
const linksOf = (raw) => {
  const out = new Map();
  for (const tl of raw.textLayers || []) {
    for (const kl of tl.tokenLayers || []) {
      for (const v of kl.vocabs || [])
        for (const l of v.vocabLinks || []) out.set(l.id, l.tokens.join(','));
    }
  }
  return out;
};
const shownLinks = (doc) => {
  const live = new Set(entities(doc.raw).keys());
  const out = new Map();
  for (const v of Object.values(doc.vocabularies || {})) {
    for (const l of v.vocabLinks || []) {
      if ((l.tokens || []).length && l.tokens.every((id) => live.has(id)))
        out.set(l.id, l.tokens.join(','));
    }
  }
  return out;
};

const differences = (shown, stored) => {
  const out = [];
  for (const [id, e] of shown) {
    const s = stored.get(id);
    if (!s) out.push(`shown, not stored: ${e.kind} ${e.layer} "${e.v}"`);
    else if (s.v !== e.v) out.push(`${e.kind} ${e.layer} shows "${e.v}", stored "${s.v}"`);
  }
  for (const [id, s] of stored) {
    if (!shown.has(id)) out.push(`stored, not shown: ${s.kind} ${s.layer} "${s.v}"`);
  }
  return out;
};

// What the server deleted: spans and relations, and links.
const deleted = (before, after, skip = () => false) => {
  const a = entities(before);
  const b = entities(after);
  let annotations = 0;
  for (const [id, e] of a) if (!b.has(id) && e.kind !== 'token' && !skip(e)) annotations += 1;
  const la = linksOf(before);
  const lb = linksOf(after);
  return { annotations, links: [...la.keys()].filter((id) => !lb.has(id)).length };
};

const word = (doc, text, n = 0) =>
  doc.sentences.flatMap((s) => s.tokens).filter((t) => t.content === text)[n];
const morphemesOf = (doc, w) =>
  (doc.layerInfo.morphemeTokenLayer?.tokens || [])
    .filter((m) => m.begin === w.begin && m.end === w.end)
    .sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0));

// Each: what the editor asks first (or null), the mutation, and what of the
// deleted entities the question leaves out by design (a merge's joined field
// values are combined, not lost).
const SCENARIOS = {
  'delete a word': {
    ask: (d) => countAnnotationLossForWord(d.layerInfo, d.vocabularies, word(d, 'today')),
    run: (d) => d.deleteToken(word(d, 'today').id),
  },
  'merge two words': {
    ask: (d) =>
      countSubWordAnnotationLoss(d.layerInfo, d.vocabularies, [
        word(d, 'fish', 1),
        word(d, 'swam'),
      ]),
    run: (d) => d.mergeTokens([word(d, 'fish', 1).id, word(d, 'swam').id]),
    joined: (e) => e.layer.endsWith('/Gloss') && !e.v.startsWith('m.'),
  },
  'split a word': {
    ask: (d) => countSplitWordLoss(d.layerInfo, d.vocabularies, word(d, 'quickly')),
    run: (d) => d.splitToken(word(d, 'quickly').id, 2),
  },
  'split a sentence': {
    ask: (d) => d.sentenceSplitLoss([word(d, 'swam').begin]),
    run: (d) => d.splitSentence(word(d, 'swam').begin),
  },
  'merge two sentences': {
    run: (d) => d.mergeSentence(d.sortedSentences[1].id),
  },
  'delete a morpheme': {
    run: (d) => d.deleteMorpheme(morphemesOf(d, word(d, 'fish'))[0].id),
  },
  'merge two morphemes': {
    run: (d) => d.mergeMorphemes(morphemesOf(d, word(d, 'fish'))[1].id),
  },
  'delete a word from the baseline': {
    run: (d) => d.saveBaselineText(d.body.replace('away ', '')),
  },
  'respell a word in the baseline': {
    run: (d) => d.saveBaselineText(d.body.replace('fish today', 'fesh today')),
  },
  'type a space in a word in the baseline': {
    run: (d) => d.saveBaselineText(d.body.replace('quickly', 'quick ly')),
  },
  'delete a line from the baseline': {
    run: (d) => d.saveBaselineText(d.body.replace('The fish swam away quickly\n', '')),
  },
};

const keep = process.argv.includes('--keep');
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const core = await coreForRun({ keep });
let failed = 0;
try {
  const client = core.client;
  const env = await setUp(client);
  console.log(`core at ${core.url}, project set up (${secs()})`);
  const user = null;
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    const id = await makeDocument(client, env, name);
    const before = await client.documents.get(id, true);
    const doc = await IgtDocument.load(client, env.projectId, id, null, { user });
    const asked = scenario.ask ? scenario.ask(doc) : null;
    const result = await scenario.run(doc);
    await doc.whenSaved();
    const after = await client.documents.get(id, true);
    const problems = [];
    if (result === false || result === null || doc.error) {
      problems.push(`the mutation failed: ${doc.error || result}`);
    }
    problems.push(...differences(entities(doc.raw, igtLayer), entities(after, igtLayer)));
    problems.push(...differences(shownLinks(doc), linksOf(after)).map((p) => `link ${p}`));
    if (asked) {
      const lost = deleted(before, after, scenario.joined);
      if (asked.annotations !== lost.annotations || asked.links !== lost.links) {
        problems.push(
          `asked about ${asked.annotations} annotations and ${asked.links} links, ` +
            `the server deleted ${lost.annotations} and ${lost.links}`,
        );
      }
    }
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${name}`);
    problems.forEach((p) => console.log(`       ${p}`));
    if (problems.length) failed += 1;
  }
  console.log(`${failed} of ${Object.keys(SCENARIOS).length} failed (${secs()})`);
} finally {
  await core.stop();
}
process.exit(failed ? 1 : 0);
