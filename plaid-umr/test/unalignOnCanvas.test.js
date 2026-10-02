// A node made unaligned on the canvas (Luke's ruling, 2026-10-03) stands
// where reconcile puts an unaligned anchor (`unalignedStretch`): one stretch
// over the text its pieces stood on, cut to its sentence, never the whole
// sentence unless it stood on a point. It stood over the whole sentence
// before, so a later sentence split in IGT anywhere after the sentence's
// start left it on the left half and deleted its relations to nodes on the
// right.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { twoWriterCore } from './twoWriterCore.js';
import { layersOf, openInUmr, openWritesNothing, splitSentenceAt, wordsOf } from './igtEdits.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'umr');
const fixture = (name) =>
  rawFromPlan(
    planImport(parseUmrFile(fs.readFileSync(path.join(FIXTURES, name), 'utf8')).sentences, []),
  );

const read = (raw) => new UmrDocument({ raw: structuredClone(raw) });
const relationIds = (raw) => new Set(layersOf(raw).relations.relations.map((r) => r.id));

// `raw` with `nodeId` made unaligned on the canvas, as stored.
async function unalign(raw, nodeId) {
  const core = twoWriterCore(raw);
  const page = await core.open('a');
  assert.ok(await page.doc.setAnchor(nodeId, []), 'unaligned');
  page.release();
  return core.raw;
}

test('a node made unaligned stands over the text its words had, and records its sentence', async () => {
  const raw = fixture('english_umr-0001.umr');
  const doc = read(raw);
  const s = doc.sentence(1);
  const node = s.nodes.find((n) => n.aligned && n.wordIds.length === 1);
  const after = read(await unalign(raw, node.id)).node(node.id);
  assert.equal(after.aligned, false);
  assert.equal(after.sentence, 1);
  assert.deepEqual(
    after.pieces.map((p) => [p.begin, p.end]),
    [[node.pieces[0].begin, node.pieces.at(-1).end]],
  );
  assert.notDeepEqual(
    after.pieces.map((p) => [p.begin, p.end]),
    [[s.begin, s.end]],
  );
  assert.equal(after.metadata.umr.sentence, s.tokenId);
});

test('a node on two words apart made unaligned stands over one stretch from the first to the last', async () => {
  const raw = fixture('english_umr-0001.umr');
  const doc = read(raw);
  const s = doc.sentence(3);
  const node = s.nodes.find((n) => n.aligned);
  const [w1, , w3] = s.words.filter((w) => !node.wordIds.includes(w.id)).slice(0, 3);
  // Two pieces first: the node on the first and third free words.
  const core = twoWriterCore(raw);
  const page = await core.open('a');
  assert.ok(await page.doc.setAnchor(node.id, [w1.id, w3.id]));
  assert.equal(page.doc.node(node.id).pieces.length, 2);
  assert.ok(await page.doc.setAnchor(node.id, []));
  assert.deepEqual(
    read(core.raw)
      .node(node.id)
      .pieces.map((p) => [p.begin, p.end]),
    [[w1.begin, w3.end]],
  );
});

// Seeded, so a failure names the run that found it.
function random(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
}

// The reconcile fuzz: on every fixture with aligned nodes that have relations, an aligned node with relations made
// unaligned on the canvas, then its sentence split in IGT at a random word
// boundary, then opened in UMR. Each relation must fare as it does when the
// node is left aligned, and the node must end in the same sentence: where
// its text is. A second open writes nothing.
const FUZZ = [
  ['english_umr-0001.umr', 12],
  ['sanapana_umr-0001.umr', 8],
  ['navajo_umr-0001.umr', 8],
  ['kukama_umr-0001.umr', 8],
  ['chinese_tlp_chapter2.umr', 4],
];

for (const [name, runs] of FUZZ) {
  test(`unaligned on the canvas, then a sentence split: relations fare as for the aligned node (${name})`, async () => {
    const original = fixture(name);
    const doc = read(original);
    const candidates = doc.sentences.flatMap((s) =>
      s.nodes.filter((n) => n.aligned && n.in.length + n.out.length > 0).map((n) => ({ s, n })),
    );
    assert.ok(candidates.length, 'a node to unalign');
    const rand = random(name.length * 7919);
    let tried = 0;
    for (let run = 0; run < runs; run++) {
      const { s, n } = candidates[Math.floor(rand() * candidates.length)];
      // A boundary between two words of its sentence, other than its start.
      const words = wordsOf(original).filter((w) => w.begin >= s.begin && w.end <= s.end);
      if (words.length < 2) continue;
      const at = words[1 + Math.floor(rand() * (words.length - 1))].begin;
      const aligned = structuredClone(original);
      const unaligned = await unalign(structuredClone(original), n.id);
      if (!splitSentenceAt(aligned, at)) continue;
      assert.ok(splitSentenceAt(unaligned, at));
      tried += 1;
      const where = `${name} run ${run}: ${n.var} split at ${at}`;
      assert.deepEqual(relationIds(unaligned), relationIds(aligned), where);
      await openInUmr(unaligned);
      await openInUmr(aligned);
      assert.deepEqual(relationIds(unaligned), relationIds(aligned), `${where}, after an open`);
      const there = read(unaligned).node(n.id);
      assert.equal(there.aligned, false, where);
      assert.equal(there.sentence, read(aligned).node(n.id).sentence, where);
      assert.ok(await openWritesNothing(unaligned), `${where}: a second open writes nothing`);
    }
    assert.ok(tried > 0, `${name}: no split was tried`);
  });
}
