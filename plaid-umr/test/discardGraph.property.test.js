// Discard graph against the provenance convention, on real corpora with
// provenance dealt at random. Every node and relation gets one of the
// states the convention names (a person's, a machine's under a known or an
// unknown producer name, a contributor's, and either origin accepted), a
// random sentence is discarded, and an oracle written apart from
// `_discardPlan` says what must go:
// - only drafted material ever goes (provState MACHINE),
// - every drafted edge of the sentence and every drafted triple its block
//   alone writes goes,
// - a drafted node of the sentence goes unless a relation that is not
//   drafted is on it,
// - and the relations on a node that goes go with it.
// The calls sent are then replayed on the raw document the way the server's
// cascade runs, and must leave what the optimistic state shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROV } from '@larc-iu/plaid-client';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'umr');
const FILES = ['english_umr-0001.umr', 'portuguese_umr-0001.umr', 'sanapana_umr-0001.umr'];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The states, as flat keys. `drafted` is the oracle's own reading of the
// convention: an origin that is not a verifier's or a contributor's, and
// not accepted.
const STATES = [
  { keys: {}, drafted: false },
  { keys: { [PROV.key]: PROV.INFERRED, [PROV.sourceKey]: 'service:umr-draft-llm' }, drafted: true },
  { keys: { [PROV.key]: 'guessed', [PROV.sourceKey]: 'service:other' }, drafted: true },
  { keys: { [PROV.key]: PROV.CONTRIBUTED, [PROV.sourceKey]: 'user:c@x.com' }, drafted: false },
  {
    keys: { [PROV.key]: PROV.INFERRED, [PROV.sourceKey]: 'service:x', [PROV.confirmedKey]: true },
    drafted: false,
  },
  {
    keys: {
      [PROV.key]: PROV.CONTRIBUTED,
      [PROV.sourceKey]: 'user:c@x.com',
      [PROV.confirmedKey]: true,
    },
    drafted: false,
  },
];

const layersOf = (raw) => {
  const nodes = raw.textLayers[0].tokenLayers.find((l) => l.config?.umr?.nodes);
  const concepts = nodes.spanLayers[0];
  return {
    tokenLayer: nodes,
    concepts,
    edges: concepts.relationLayers.find((l) => l.config?.umr?.relations),
    triples: concepts.relationLayers.find((l) => l.config?.umr?.documentGraph),
  };
};

// Deal the states. Mostly drafted, so the interesting cases (a drafted node
// held by one kept relation) come up often.
function deal(raw, rand) {
  const pick = () =>
    rand() < 0.55 ? STATES[1 + Math.floor(rand() * 2)] : STATES[Math.floor(rand() * STATES.length)];
  const L = layersOf(raw);
  const drafted = new Map();
  const stamp = (x) => {
    const s = pick();
    x.metadata = { ...(x.metadata || {}), ...s.keys };
    drafted.set(x.id, s.drafted);
  };
  L.concepts.spans.forEach(stamp);
  (L.edges.relations || []).forEach(stamp);
  (L.triples.relations || []).forEach(stamp);
  return drafted;
}

// What the server keeps after the calls: a relation deleted by id, tokens
// deleted, a span whose every token went deleted, and every relation on a
// deleted span with it.
function replay(raw, calls) {
  const L = layersOf(raw);
  const deletedRelations = new Set(
    calls.filter((c) => c.name === 'relations.delete').map((c) => c.args[0]),
  );
  const deletedTokens = new Set(
    calls.filter((c) => c.name === 'tokens.bulkDelete').flatMap((c) => c.args[0]),
  );
  const spans = L.concepts.spans.filter((s) => (s.tokens || []).some((t) => !deletedTokens.has(t)));
  const live = new Set(spans.map((s) => s.id));
  const keep = (r) => !deletedRelations.has(r.id) && live.has(r.source) && live.has(r.target);
  return {
    spans: new Set(spans.map((s) => s.id)),
    relations: new Set(
      [...(L.edges.relations || []), ...(L.triples.relations || [])].filter(keep).map((r) => r.id),
    ),
  };
}

function docState(doc) {
  const L = layersOf(doc._raw);
  return {
    spans: new Set(L.concepts.spans.map((s) => s.id)),
    relations: new Set(
      [...(L.edges.relations || []), ...(L.triples.relations || [])].map((r) => r.id),
    ),
  };
}

const sorted = (set) => [...set].sort();

function runOne(file, seed) {
  const plan = planImport(
    parseUmrFile(fs.readFileSync(path.join(DIR, file), 'utf8')).sentences,
    [],
  );
  const raw = rawFromPlan(plan);
  const rand = rng(seed);
  const drafted = deal(raw, rand);
  const pristine = structuredClone(raw);
  const { client, calls, requests } = recordingClient();
  const doc = new UmrDocument({ raw, client, user: { id: 'v@x.com' } });
  const n = doc.sentences.length;
  const index = 1 + Math.floor(rand() * n);
  const sentence = doc.sentence(index);

  // The oracle, from the parsed graph and the dealt states only.
  const otherTriples = new Set(
    doc.sentences.filter((s) => s.index !== index).flatMap((s) => s.triples.map((t) => t.id)),
  );
  const own = new Set([
    ...sentence.edges.map((e) => e.id),
    ...sentence.triples.filter((t) => !otherTriples.has(t.id)).map((t) => t.id),
  ]);
  const on = (node) => [...node.in, ...node.out, ...node.docIn, ...node.docOut];
  const doomed = new Set(
    sentence.nodes
      .filter((nd) => !nd.constant && drafted.get(nd.id) && on(nd).every((r) => drafted.get(r.id)))
      .map((nd) => nd.id),
  );
  const gone = new Set([...own].filter((id) => drafted.get(id)));
  doomed.forEach((id) => on(doc.node(id)).forEach((r) => gone.add(r.id)));
  const others = new Set([...gone].filter((id) => !own.has(id)));

  const before = docState(doc);
  const planned = doc.discardPlan(index);
  assert.deepEqual(
    sorted(new Set(planned.nodes.map((x) => x.id))),
    sorted(doomed),
    'planned nodes',
  );
  assert.deepEqual(
    sorted(new Set(planned.relations.map((x) => x.id))),
    sorted(gone),
    'planned relations',
  );
  assert.equal(planned.otherRelations, others.size, 'relations other sentences lose');
  assert.equal(doc.canDiscardSentence(index), doomed.size + gone.size > 0);
  return { doc, index, before, doomed, gone, drafted, pristine, calls, requests };
}

test('Discard graph removes exactly the drafted material the convention allows, on random provenance', async () => {
  let discarded = 0;
  let heldNodes = 0;
  for (const file of FILES) {
    for (let seed = 1; seed <= 40; seed++) {
      const ctx = runOne(file, seed * 7919 + file.length);
      const { doc, index, before, doomed, gone, drafted, pristine, calls, requests } = ctx;
      const where = `${file} seed ${seed} sentence ${index}`;
      const ok = await doc.discardSentence(index);
      assert.equal(ok, doomed.size + gone.size > 0, where);
      if (!ok) {
        assert.equal(calls.length, 0, `${where}: nothing sent`);
        continue;
      }
      discarded++;
      // One operation, one round trip.
      assert.deepEqual(
        calls.filter((c) => c.name === 'operation').map((c) => c.args[0]),
        [`Discard the drafted graph of sentence ${index}`],
        where,
      );
      assert.equal(requests.length, 1, `${where}: one batch`);
      // The optimistic state is the oracle's.
      const after = docState(doc);
      assert.deepEqual(
        sorted(after.spans),
        sorted(new Set([...before.spans].filter((id) => !doomed.has(id)))),
        `${where}: nodes left`,
      );
      assert.deepEqual(
        sorted(after.relations),
        sorted(new Set([...before.relations].filter((id) => !gone.has(id)))),
        `${where}: relations left`,
      );
      // Only drafted material went.
      [...doomed, ...gone].forEach((id) => assert.equal(drafted.get(id), true, `${where}: ${id}`));
      // Nothing drafted of this sentence's own is left, but a node held by
      // a relation that stays.
      doc.sentence(index).nodes.forEach((nd) => {
        if (drafted.get(nd.id) && !nd.constant) {
          heldNodes++;
          const holders = [...nd.in, ...nd.out, ...nd.docIn, ...nd.docOut];
          assert.ok(
            holders.some((r) => !drafted.get(r.id)),
            `${where}: ${nd.var} is drafted and held by nothing kept`,
          );
        }
      });
      doc
        .sentence(index)
        .edges.forEach((e) =>
          assert.equal(drafted.get(e.id), false, `${where}: drafted edge ${e.role} left`),
        );
      // The server, running the same calls with its cascade, ends where
      // the optimistic state does.
      const server = replay(pristine, calls);
      assert.deepEqual(sorted(server.spans), sorted(after.spans), `${where}: server spans`);
      assert.deepEqual(
        sorted(server.relations),
        sorted(after.relations),
        `${where}: server relations`,
      );
      // Nothing left to discard.
      assert.equal(doc.canDiscardSentence(index), false, `${where}: again`);
    }
  }
  assert.ok(discarded > 60, `enough discards (${discarded})`);
  assert.ok(heldNodes > 5, `drafted nodes held by a kept relation came up (${heldNodes})`);
});

test('a random discard counts the drafted relations other sentences lose', () => {
  let seen = 0;
  for (const file of FILES) {
    for (let seed = 1; seed <= 40; seed++) {
      const { doc, index } = runOne(file, seed * 104729 + 3);
      if (doc.discardPlan(index).otherRelations > 0) seen++;
    }
  }
  assert.ok(seen > 5, `plans that reach other sentences came up (${seen})`);
});
