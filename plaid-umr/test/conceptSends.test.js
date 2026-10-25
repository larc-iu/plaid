// What setConcept sends (REV-W1-APPS G-2): an entry picked for the concept a
// node already has sends its metadata ops and no update, and a relabel of a
// drafted node sends the update and the writer's stamp in one batch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROV } from '@larc-iu/plaid-client';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const TEXT = `################################################################################
# :: snt1
Index: 1 2
Words: kitap verdi

# sentence level graph:
(s1v / ver-01
    :ARG1 (s1k / kitap))

# alignment:
s1v: 2-2
s1k: 1-1

# document level annotation:
(s1s0 / sentence)
`;

const VOCAB = { id: 'v1', name: 'Turkish', items: [{ id: 'kitap', form: 'kitap', metadata: {} }] };

async function load() {
  const raw = rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));
  raw.textLayers[0].tokenLayers
    .find((l) => l.config?.umr?.nodes)
    .spanLayers[0].spans.forEach((s) => {
      s.metadata = { [PROV.key]: PROV.INFERRED, [PROV.sourceKey]: 'service:x', ...s.metadata };
    });
  const { client, calls, requests } = recordingClient();
  client.vocabLayers = { get: async () => VOCAB };
  const doc = new UmrDocument({
    raw,
    client,
    project: { id: 'p', vocabs: [{ id: 'v1' }] },
    user: null,
  });
  doc._reload = async () => {};
  doc.onError = (msg) => {
    throw new Error(msg);
  };
  await doc.loadLexicon();
  return { doc, calls, requests };
}

const byVar = (doc, v) => [...doc.graph.nodesById.values()].find((n) => n.var === v);
const sends = (calls) =>
  calls.filter((c) => c.name.startsWith('spans.')).map((c) => [c.name, c.args[0]]);

test('an entry picked for the concept a node has sends its metadata and no update', async () => {
  const { doc, calls, requests } = await load();
  const node = byVar(doc, 's1k');
  assert.equal(await doc.setConcept(node.id, 'kitap', { entry: 'kitap' }), true);
  assert.equal(byVar(doc, 's1k').metadata.umr.entry, 'kitap');
  assert.deepEqual(sends(calls), [['spans.patchMetadata', node.id]]);
  assert.deepEqual(
    requests.map((r) => r.name),
    ['batch'],
  );
});

test('a relabel of a drafted node sends the update and its stamp in one batch', async () => {
  const { doc, calls, requests } = await load();
  const node = byVar(doc, 's1k');
  assert.equal(await doc.setConcept(node.id, 'defter'), true);
  assert.equal(byVar(doc, 's1k').concept, 'defter');
  assert.deepEqual(sends(calls), [
    ['spans.update', node.id],
    ['spans.patchMetadata', node.id],
  ]);
  const stamp = calls.find((c) => c.name === 'spans.patchMetadata').args[1];
  // The writer's stamp: a drafted node a person relabels is settled.
  assert.deepEqual(stamp, [{ op: 'set', path: ['provConfirmed'], value: true }]);
  assert.deepEqual(
    requests.map((r) => [r.name, ...r.args]),
    [['batch', 2]],
  );
});
