// B5-1: a node's delete takes its anchor tokens, and the copy shows at once
// what core's cascade takes with them on every layer, not only UMR's own:
// another app's span on an anchor, a relation on that span, and a token of a
// layer nested under the nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

const ids = (list) => (list || []).map((x) => x.id);

function load() {
  const raw = rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));
  const layers = raw.textLayers[0].tokenLayers;
  const nodes = layers.find((l) => l.config?.umr?.nodes);
  const kitap = nodes.spanLayers[0].spans.find((s) => s.metadata.umr.var === 's1k');
  const verdi = nodes.spanLayers[0].spans.find((s) => s.metadata.umr.var === 's1v');
  const anchor = nodes.tokens.find((t) => t.id === kitap.tokens[0]);
  nodes.spanLayers.push({
    id: 'other-notes',
    spans: [
      { id: 'on1', tokens: [anchor.id], value: 'book' },
      { id: 'on2', tokens: [verdi.tokens[0]], value: 'gave' },
    ],
    relationLayers: [
      { id: 'other-rel', relations: [{ id: 'or1', source: 'on2', target: 'on1', value: 'x' }] },
    ],
  });
  layers.push({
    id: 'other-under',
    parentTokenLayer: nodes.id,
    tokens: [{ id: 'ou1', begin: anchor.begin, end: anchor.end }],
    spanLayers: [],
  });
  const { client } = recordingClient();
  const doc = new UmrDocument({ raw, client, user: null });
  doc._reload = async () => {};
  doc.onError = (msg) => {
    throw new Error(msg);
  };
  return { doc, kitap };
}

test("deleting a node takes another layer's span, relation and nested token on its anchor at once", async () => {
  const { doc, kitap } = load();
  const layers = () => doc.layerInfo.textLayer.tokenLayers;
  const pending = doc.deleteNode(kitap.id, { subtree: false });
  const notes = doc.layerInfo.nodeTokenLayer.spanLayers.find((l) => l.id === 'other-notes');
  assert.deepEqual(ids(notes.spans), ['on2']);
  assert.deepEqual(ids(notes.relationLayers[0].relations), []);
  assert.deepEqual(ids(layers().find((l) => l.id === 'other-under').tokens), []);
  assert.ok(await pending);
});
