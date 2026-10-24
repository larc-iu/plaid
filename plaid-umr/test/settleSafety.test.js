// REV-W2B-OPENS M1, M2, M3: what the first UMR write to a sentence stores of
// the reader's answer (umrSettle.js) never makes stored data worse than it
// was. M1: the settle is planned on the document before the edit, so a
// refusal of the edit after the settle lands leaves no two nodes of one
// sentence sharing a variable. M2: renumbering is stored for the whole
// document at once, so a held relation keeps pointing at the node it named.
// M3: the settle never deletes an entry link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { clientOver, layersOf, mergeSentence } from './igtEdits.js';

const SEP = '#'.repeat(80);
const block = (n, words, graph, alignment, doc = `(s${n}s0 / sentence)`) => `${SEP}
# :: snt${n}
Index: ${words.map((_, i) => i + 1).join(' ')}
Words: ${words.join(' ')}

# sentence level graph:
${graph}

# alignment:
${alignment}

# document level annotation:
${doc}
`;

const storedVars = (raw) =>
  layersOf(raw)
    .concepts.spans.map((s) => s.metadata?.umr?.var)
    .filter(Boolean);
const byStored = (doc, v) => [...doc.graph.nodesById.values()].find((n) => n.storedVar === v);
const refusing = (raw) => {
  const base = clientOver(raw);
  return {
    ...base,
    documents: { ...base.documents, get: async () => structuredClone(raw) },
    spans: {
      ...base.spans,
      patchMetadata: async () => {
        throw Object.assign(new Error('refused'), { status: 422 });
      },
    },
  };
};

test('a rename refused after the settle landed leaves no variable naming two nodes', async () => {
  const TEXT = [
    block(
      1,
      ['Ali', 'geldi', '.'],
      '(s1g / gel-01\n    :ARG1 (s1a / person))',
      's1g: 2-2\ns1a: 1-1',
    ),
    block(
      2,
      ['Ayse', 'gitti', '.'],
      '(s2g / git-01\n    :ARG1 (s2a / person))',
      's2g: 2-2\ns2a: 1-1',
    ),
  ].join('\n');
  const raw = rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));
  layersOf(raw).nodes.tokens.forEach((t) => {
    if (t.metadata?.umr) delete t.metadata.umr.snt;
  });
  mergeSentence(raw, 2);
  const errors = [];
  const doc = new UmrDocument({ raw: structuredClone(raw), client: refusing(raw) });
  doc._reload = async () => doc._swapRaw(structuredClone(raw));
  doc.onError = (m) => errors.push(m);
  // s2a now stands in sentence 1, beside s1a, and reads as s1a2.
  assert.equal(byStored(doc, 's2a').var, 's1a2');
  const ok = await doc.setVariable(byStored(doc, 's1a').id, 's1q');
  assert.equal(ok, false);
  const vars = storedVars(raw);
  assert.equal(new Set(vars).size, vars.length, `stored ${vars.join(' ')}`);
  const after = new UmrDocument({ raw: structuredClone(raw) });
  assert.doesNotThrow(() => after.toUmr());
});

test('renumbering one sentence keeps every held relation on the node it named', async () => {
  // Sentence 4 is kept as text, and its block holds two relations naming
  // the persons of sentences 2 and 3.
  const TEXT = [
    block(
      1,
      ['Ali', 'geldi', '.'],
      '(s1g / gel-01\n    :ARG1 (s1a / person))',
      's1g: 2-2\ns1a: 1-1',
    ),
    block(
      2,
      ['Ayse', 'gitti', '.'],
      '(s2g / git-01\n    :ARG1 (s2p / person))',
      's2g: 2-2\ns2p: 1-1',
    ),
    block(
      3,
      ['Can', 'kaldi', '.'],
      '(s3g / kal-01\n    :ARG1 (s3p / person))',
      's3g: 2-2\ns3p: 1-1',
    ),
    block(
      4,
      ['O', 'uyudu', '.'],
      '(s4g / uyu-01\n    :ARG1 (s4x / "person)',
      's4g: 2-2',
      '(s4s0 / sentence\n    :coref ((s4x :same-entity s3p)\n        (s4x :subset-of s2p)))',
    ),
  ].join('\n');
  const raw = rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));
  layersOf(raw).nodes.tokens.forEach((t) => {
    if (t.metadata?.umr) delete t.metadata.umr.snt;
  });
  const opened = new UmrDocument({ raw: structuredClone(raw) });
  assert.equal(opened.sentence(4).nodes.length, 0, 'sentence 4 is kept as text');
  assert.equal(opened.sentence(4).held.length, 2);
  mergeSentence(raw, 2);
  const doc = new UmrDocument({ raw: structuredClone(raw), client: clientOver(raw) });
  doc._reload = async () => doc._swapRaw(structuredClone(raw));
  doc.onError = (m) => {
    throw new Error(m);
  };
  const second = byStored(doc, 's2p');
  const third = byStored(doc, 's3p');
  const heldOn = (d) => Object.fromEntries(d.sentence(3).held.map((h) => [h.rel, h.target]));
  const nameOf = (d, id) => d.graph.nodesById.get(id).var;
  assert.deepEqual(heldOn(doc), {
    ':same-entity': nameOf(doc, third.id),
    ':subset-of': nameOf(doc, second.id),
  });
  assert.ok(await doc.setConcept(third.id, 'man'));
  const after = new UmrDocument({ raw: structuredClone(raw) });
  assert.deepEqual(heldOn(after), {
    ':same-entity': nameOf(after, third.id),
    ':subset-of': nameOf(after, second.id),
  });
  const vars = storedVars(raw);
  assert.equal(new Set(vars).size, vars.length, `stored ${vars.join(' ')}`);
  // A second write elsewhere keeps them so.
  assert.ok(await doc.setConcept(byStored(doc, 's1a')?.id ?? second.id, 'woman'));
  const last = new UmrDocument({ raw: structuredClone(raw) });
  assert.deepEqual(heldOn(last), {
    ':same-entity': nameOf(last, third.id),
    ':subset-of': nameOf(last, second.id),
  });
});

test('a write never deletes the link of a node to an entry the tab has not read', async () => {
  const TEXT = block(
    1,
    ['Ali', 'geldi', '.'],
    '(s1g / gel-01\n    :ARG1 (s1a / person))',
    's1g: 2-2\ns1a: 1-1',
  );
  const raw = rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));
  const geldi = layersOf(raw).concepts.spans.find((s) => s.metadata.umr.var === 's1g');
  // Linked by another tab to an entry made after this tab read the lexicon.
  geldi.metadata.umr.entry = 'new-entry';
  geldi.metadata.umr.entryVocab = 'v1';
  const lexicon = { byId: new Map(), entries: [], readVocabs: new Set(['v1']) };
  const doc = new UmrDocument({ raw: structuredClone(raw), client: clientOver(raw), lexicon });
  doc._reload = async () => doc._swapRaw(structuredClone(raw));
  assert.ok(await doc.setConcept(byStored(doc, 's1a').id, 'woman'));
  assert.equal(geldi.metadata.umr.entry, 'new-entry');
  assert.equal(geldi.metadata.umr.entryVocab, 'v1');
});

test('a write whose settle waited behind a write refused meanwhile is refused unsent', async () => {
  const TEXT = [
    block(
      1,
      ['Ali', 'geldi', '.'],
      '(s1g / gel-01\n    :ARG1 (s1a / person))',
      's1g: 2-2\ns1a: 1-1',
    ),
    block(
      2,
      ['Ayse', 'gitti', '.'],
      '(s2g / git-01\n    :ARG1 (s2a / person))',
      's2g: 2-2\ns2a: 1-1',
    ),
  ].join('\n');
  const raw = rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));
  // Another app deleted the word under s2a: sentence 2 has that to store.
  const L = layersOf(raw);
  const body = [...raw.textLayers[0].text.body];
  L.word.tokens = L.word.tokens.filter((t) => body.slice(t.begin, t.end).join('') !== 'Ayse');
  let open;
  const gate = new Promise((r) => (open = r));
  const base = clientOver(raw);
  const sent = [];
  const client = {
    ...base,
    documents: { ...base.documents, get: async () => structuredClone(raw) },
    spans: {
      ...base.spans,
      patchMetadata: async () => {
        await gate;
        throw Object.assign(new Error('refused'), { status: 422 });
      },
    },
    batched: async (fn) => {
      sent.push('batch');
      return base.batched(fn);
    },
  };
  const doc = new UmrDocument({ raw: structuredClone(raw), client });
  doc._reload = async () => doc._swapRaw(structuredClone(raw));
  doc.onError = () => {};
  const first = doc.setVariable(byStored(doc, 's1a').id, 's1q');
  const second = doc.setConcept(byStored(doc, 's2a').id, 'woman');
  open();
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.deepEqual(sent, [], 'nothing of the second write was sent');
  const ayse = layersOf(raw).concepts.spans.find((s) => s.metadata.umr.var === 's2a');
  assert.equal(ayse.value, 'person');
  assert.equal(ayse.metadata.umr.sentence, undefined);
});
