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
import { insertSentenceAtStart } from './igtInsertSentence.js';

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

test('when IGT adds a sentence before them, held relations follow the renumbered nodes and no node takes a kept name', async () => {
  const { doc, calls } = load();
  // IGT added a sentence at the start: every sentence moves down by one. (An
  // imported file whose first sentence IGT deleted keeps its names, since
  // its stored numbers no longer run 1, 2, 3: see reconcileNarrowings.)
  const raw = doc._raw;
  insertSentenceAtStart(raw);
  const moved = new UmrDocument({ raw, client: doc._client });
  moved._reload = async () => {};
  // What was sentence 38 is 39 now, and holds relations to s38i2 and the rest.
  assert.ok(names(moved.sentence(39).held).some((t) => t.includes('s38i2')));
  const kept = new Set(
    [...moved.sentence(38).rawGraph.matchAll(/\(\s*([^\s/()"]+)\s*\//g)].map((m) => m[1]),
  );
  assert.ok(kept.has('s37i2'));
  await moved._reconcile();
  const patch = calls.find(
    (c) => c.name === 'tokens.patchMetadata' && c.args[0] === moved.sentence(39).tokenId,
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
  assert.equal(newName('s38i2'), 's39i2');
  // Sentence 36's nodes, now in sentence 37, take no name the kept graph
  // (now sentence 38) defines.
  const clashes = [...moved.sentence(37).nodes].filter((n) => kept.has(`s37${n.var.slice(3)}`));
  assert.ok(clashes.length, 'the kept graph and sentence 36 share a name after the number');
  assert.ok(![...renamed.values()].some((v) => kept.has(v)), 'no renamed node takes a kept name');
  assert.ok(held.some((h) => h.source === 's39i2' || h.target === 's39i2'));
  assert.ok(!held.some((h) => h.source === 's38i2' || h.target === 's38i2'));
});
