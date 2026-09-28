// Document-level relations naming a node of a graph the import could not
// read (the owner's ruling of 2026-09-28): held by name on the sentence
// whose block wrote them, written back there on export, and made real when
// the graph is mended in Text mode. Sanapana sentence 37 has an unterminated
// string, and its own block and the blocks of 38 and 57 name its nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'umr',
  'sanapana_umr-0001.umr',
);

const load = () => {
  const warnings = [];
  const plan = planImport(parseUmrFile(fs.readFileSync(FILE, 'utf8')).sentences, warnings);
  const raw = rawFromPlan(plan);
  const { client, calls } = recordingClient();
  const doc = new UmrDocument({ raw, client });
  doc._reload = async () => {};
  doc.onError = (msg) => {
    throw new Error(msg);
  };
  return { doc, calls, warnings };
};

const names = (list) => list.map((h) => `${h.source} ${h.rel} ${h.target}`);

test('the relations naming a kept graph are held on the block that wrote them, and reported so', () => {
  const { doc, warnings } = load();
  assert.equal(doc.sentence(37).nodes.length, 0, 'sentence 37 is kept as text');
  assert.equal(doc.sentence(37).held.length, 6);
  assert.ok(names(doc.sentence(37).held).includes('author :full-affirmative s37e'));
  assert.equal(doc.sentence(38).held.length, 3);
  assert.equal(doc.sentence(57).held.length, 1);
  assert.ok(
    warnings.includes(
      'Sentence 37: 6 document-level relations are held until sentence 37 is mended.',
    ),
  );
  assert.ok(
    warnings.includes(
      'Sentence 57: 1 document-level relation is held until sentence 37 is mended.',
    ),
  );
  assert.ok(!warnings.some((w) => /dropped, no node s37/.test(w)), 'nothing said to be dropped');
});

test('the export writes each held relation back in its own block', () => {
  const { doc } = load();
  const again = parseUmrFile(doc.toUmr());
  const block = (i) => {
    const dg = again.sentences[i - 1].docGraph || {};
    return ['temporal', 'modal', 'coref'].flatMap((g) => (dg[g] || []).map((t) => t.join(' ')));
  };
  names(doc.sentence(37).held).forEach((t) => assert.ok(block(37).includes(t), t));
  names(doc.sentence(38).held).forEach((t) => assert.ok(block(38).includes(t), t));
  names(doc.sentence(57).held).forEach((t) => assert.ok(block(57).includes(t), t));
});

test('mending the graph in Text mode makes every held relation real, in the same operation', async () => {
  const { doc, calls } = load();
  const kept = doc.penmanOf(37);
  const mended = kept.replace('"Río_Verde_Paraguay)', '"Río_Verde_Paraguay")');
  assert.notEqual(mended, kept);
  const changes = await doc.applyPenman(37, mended);
  assert.ok(changes > 0);
  // One operation.
  assert.equal(calls.filter((c) => c.name === 'operation').length, 1);
  const docLayer = doc.layerInfo.documentGraphLayer.id;
  const made = calls
    .filter((c) => c.name === 'relations.bulkCreate')
    .flatMap((c) => c.args[0])
    .filter((r) => r.relationLayerId === docLayer);
  assert.equal(made.length, 10);
  // The sentences no longer hold them, and 37 no longer keeps its old text.
  [37, 38, 57].forEach((i) => assert.equal(doc.sentence(i).held.length, 0, `sentence ${i}`));
  assert.equal(doc.sentence(37).rawGraph, null);
  const patched = calls.filter((c) => c.name === 'tokens.patchMetadata');
  assert.equal(patched.length, 3);
  // The ten are real relations on the mended nodes, where the canvas shows them.
  const e = [...doc.graph.nodesById.values()].find((n) => n.var === 's37e');
  assert.ok(
    [...e.docIn, ...e.docOut].some((t) => t.rel === ':full-affirmative'),
    's37e wears author :full-affirmative',
  );
  // The export writes each once, from the relations now.
  const again = parseUmrFile(doc.toUmr());
  const all = again.sentences.flatMap((s) =>
    ['temporal', 'modal', 'coref'].flatMap((g) => (s.docGraph?.[g] || []).map((t) => t.join(' '))),
  );
  assert.equal(all.filter((t) => t === 'author :full-affirmative s37e').length, 1);
});

test('when IGT removes a sentence before them, held relations follow the renumbered nodes and no node takes a kept name', async () => {
  const { doc, calls } = load();
  // IGT deleted sentence 1: its token, its words and, by the cascade, its
  // nodes. Every later sentence moves up by one.
  const raw = doc._raw;
  const text = raw.textLayers[0];
  const role = (r) => text.tokenLayers.find((l) => l.config?.plaid?.role === r);
  const sentences = role('sentence');
  const first = [...sentences.tokens].sort((a, b) => a.begin - b.begin)[0];
  sentences.tokens = sentences.tokens.filter((t) => t.id !== first.id);
  role('word').tokens = role('word').tokens.filter((t) => t.begin >= first.end);
  const nodes = text.tokenLayers.find((l) => l.config?.umr?.nodes);
  const gone = new Set(
    nodes.tokens.filter((t) => t.end <= first.end && t.end > 0).map((t) => t.id),
  );
  nodes.tokens = nodes.tokens.filter((t) => !gone.has(t.id));
  const concepts = nodes.spanLayers[0];
  const dead = new Set(
    concepts.spans
      .filter((s) => s.tokens.length && s.tokens.every((t) => gone.has(t)))
      .map((s) => s.id),
  );
  concepts.spans = concepts.spans.filter((s) => !dead.has(s.id));
  concepts.relationLayers.forEach((rl) => {
    rl.relations = rl.relations.filter((r) => !dead.has(r.source) && !dead.has(r.target));
  });
  const moved = new UmrDocument({ raw, client: doc._client });
  moved._reload = async () => {};
  // What was sentence 38 is 37 now, and holds relations to s38i2 and the rest.
  assert.ok(names(moved.sentence(37).held).some((t) => t.includes('s38i2')));
  await moved._reconcile();
  const patch = calls.find(
    (c) => c.name === 'tokens.patchMetadata' && c.args[0] === moved.sentence(37).tokenId,
  );
  assert.ok(patch, 'the sentence that holds them is patched');
  const held = patch.args[1][0].value;
  const renamed = new Map(
    calls
      .filter((c) => c.name === 'spans.patchMetadata')
      .flatMap((c) =>
        c.args[1].filter((o) => o.path[1] === 'var').map((o) => [c.args[0], o.value]),
      ),
  );
  const newName = (v) =>
    renamed.get([...moved.graph.nodesById.values()].find((n) => n.var === v).id);
  // s38i2 is not given s37i2, which the kept graph (now sentence 36) defines.
  assert.notEqual(newName('s38i2'), 's37i2');
  assert.ok(held.some((h) => h.source === newName('s38i2') || h.target === newName('s38i2')));
  assert.ok(!held.some((h) => h.source === 's38i2' || h.target === 's38i2'));
});
