// When a sentence's stored lines move to the sentence after it, and when they
// stay (sentenceGraph.js recordsFollowTheirGraphs), and what number a triple
// between two constants records at import (umrImport.js).
//
// A sentence typed in before an existing one in IGT takes that one's token
// and its record, and the record then follows the graph it describes. The
// same shape (a sentence with a record and no nodes, then one with nodes and
// no record) also arises from a sentence the file left with no graph, or
// whose graph was deleted, followed by one added in IGT and annotated. Only
// the numbers tell them apart, and the move must be left out whenever they
// could mean the second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMetadataOps } from '@larc-iu/plaid-client';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { toUmrSentences } from '../src/domain/sentenceGraph.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';
import { insertSentenceAtStart } from './igtInsertSentence.js';

const SEP = '#'.repeat(80);
// A sentence whose graph names its variables s<v>, written as snt<n>.
const block = (n, { v = n, words = 'Ali geldi .', modal = false } = {}) => `${SEP}
# :: snt${n}
Index: 1 2 3
Words: ${words}
Gloss: ${words}

# sentence level graph:
(s${v}g / gel-01
    :ARG1 (s${v}a / person))

# alignment:
s${v}g: 2-2
s${v}a: 1-1

# document level annotation:
(s${v}s0 / sentence${modal ? '\n    :modal ((root :modal author))' : ''})
`;
// A sentence the file leaves with no graph.
const bare = (n, words = 'Veli uyudu .') => `${SEP}
# :: snt${n}
Index: 1 2 3
Words: ${words}
Gloss: ${words}

# sentence level graph:


# alignment:


# document level annotation:
(s${n}s0 / sentence)
`;

const role = (raw, r) => raw.textLayers[0].tokenLayers.find((l) => l.config?.plaid?.role === r);
const fromText = (text) => rawFromPlan(planImport(parseUmrFile(text).sentences, []));
// A sentence added in IGT stores nothing on its token.
const added = (raw, i) => {
  delete role(raw, 'sentence').tokens[i].metadata.umr;
};

function open(raw) {
  const { client, calls } = recordingClient();
  client.tokens.update = async (...args) => calls.push({ name: 'tokens.update', args });
  const doc = new UmrDocument({ raw, client });
  doc._reload = async () => {};
  return { doc, calls };
}

function applyPatches(raw, calls) {
  const layer = raw.textLayers[0];
  const all = layer.tokenLayers.flatMap((l) => [
    ...l.tokens,
    ...(l.spanLayers || []).flatMap((s) => [
      ...s.spans,
      ...(s.relationLayers || []).flatMap((r) => r.relations),
    ]),
  ]);
  calls.forEach(({ name, args }) => {
    if (!name.endsWith('.patchMetadata')) return;
    const target = all.find((x) => x.id === args[0]);
    target.metadata = applyMetadataOps(target.metadata || {}, args[1]);
  });
}

const records = (doc) => doc.graph.sentences.map((s) => [s.text, s.snt]);

test('an excerpt: a sentence added after one with no graph and annotated keeps no stored lines', async () => {
  // Numbered from 2. "Ayşe koştu ." was added after "Veli uyudu ." in IGT
  // and annotated, so its nodes are named by position, s3, which is also
  // the number "Veli uyudu ." stores.
  const raw = fromText(`${block(2)}\n${bare(3)}\n${block(9, { v: 3, words: 'Ayşe koştu .' })}`);
  added(raw, 2);
  const { doc, calls } = open(raw);
  assert.deepEqual(records(doc), [
    ['Ali geldi .', 2],
    ['Veli uyudu .', 3],
    ['Ayşe koştu .', null],
  ]);
  assert.deepEqual(
    toUmrSentences(doc.graph).map((s) => s.snt),
    [2, 3, 4],
  );
  const result = await doc._reconcile();
  assert.deepEqual(result, { findings: [] });
  assert.deepEqual(calls, []);
});

test('a sentence added after one with no graph, then one typed in before both, moves no stored lines', async () => {
  // Imported snt1 to snt3, "Veli uyudu ." (snt2) with no graph. "Ayşe koştu
  // ." was added after it and annotated at position 3 (s3), and the open
  // renumbered the old snt3 to s4. Then "Yeni ." was added after the first
  // sentence, so "Veli uyudu ." is at 3 and "Ayşe koştu ." at 4.
  const raw = fromText(
    [
      block(1),
      bare(7, 'Yeni .'),
      bare(2),
      block(8, { v: 3, words: 'Ayşe koştu .' }),
      block(3, { v: 4, words: 'Can yüzdü .' }),
    ].join('\n'),
  );
  added(raw, 1);
  added(raw, 3);
  const { doc, calls } = open(raw);
  assert.deepEqual(records(doc), [
    ['Ali geldi .', 1],
    ['Yeni .', null],
    ['Veli uyudu .', 2],
    ['Ayşe koştu .', null],
    ['Can yüzdü .', 3],
  ]);
  const result = await doc._reconcile();
  assert.equal(result.recordsMoved, 0);
  assert.equal(result.renumbered, 4);
  assert.deepEqual(
    calls.filter((c) => c.name === 'tokens.patchMetadata'),
    [],
  );
});

test('two sentences typed in before the first, with no open between, still move its stored lines once', async () => {
  const raw = fromText(`${block(1, { modal: true })}\n${block(2)}`);
  const kept = insertSentenceAtStart(raw, 'Bir .');
  // The second one is typed in before the first new one, which takes the
  // token again; the first new one is now a bare sentence with no nodes.
  const sentences = role(raw, 'sentence').tokens;
  const layer = raw.textLayers[0];
  const text = 'İki .';
  const shift = [...text].length + 1;
  layer.text.body = `${text}\n${layer.text.body}`;
  layer.tokenLayers.forEach((l) =>
    l.tokens.forEach((t) => {
      if (t.id === kept) return;
      t.begin += shift;
      t.end += shift;
    }),
  );
  const oldEnd = sentences.find((t) => t.id === kept).end;
  sentences.find((t) => t.id === kept).end = shift - 1;
  sentences.push({ id: 'igt-right-2', begin: shift, end: oldEnd + shift });
  role(raw, 'word').tokens.push({ id: 'igt-w-2', begin: 0, end: 3 });
  const { doc, calls } = open(raw);
  assert.deepEqual(records(doc), [
    ['İki .', null],
    ['Bir .', null],
    ['Ali geldi .', 1],
    ['Ali geldi .', 2],
  ]);
  const result = await doc._reconcile();
  assert.equal(result.recordsMoved, 1);
  applyPatches(raw, calls);
  const again = open(raw);
  assert.deepEqual(records(again.doc), records(doc));
  assert.deepEqual(await again.doc._reconcile(), { findings: [] });
});

test('a file whose snt numbers skip one keeps a triple between constants on its sentence', async () => {
  // snt1, snt2, snt4, snt5: read by position, and the variables renumbered
  // to match. The triple written in snt5's block stays on that sentence.
  const raw = fromText(`${block(1)}\n${block(2)}\n${block(4)}\n${block(5, { modal: true })}`);
  const { doc, calls } = open(raw);
  assert.deepEqual(
    doc.graph.sentences.map((s) => s.triples.length),
    [0, 0, 0, 1],
  );
  const result = await doc._reconcile();
  assert.equal(result.renumbered, 4);
  applyPatches(raw, calls);
  const again = open(raw);
  assert.deepEqual(
    again.doc.graph.sentences.map((s) => s.triples.length),
    [0, 0, 0, 1],
  );
  const [before, last] = again.doc.toUmr().split('# :: snt4');
  assert.doesNotMatch(before, /root :modal author/);
  assert.match(last, /root :modal author/);
  assert.deepEqual(await again.doc._reconcile(), { findings: [] });
});
