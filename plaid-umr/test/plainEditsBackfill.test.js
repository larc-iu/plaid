// UMR's node layer declares `plainEdits` (Luke, 2026-09-30): a text edit then
// grows or shrinks a node with the word it stands on, never splits one, and
// deletes one only when all its letters are gone. A project made before the
// key existed picks it up on a maintainer's open, in one batch that names
// what the page read (compare-and-set). Nobody else declares it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAID_NAMESPACE, PLAIN_EDITS_KEY } from '@larc-iu/plaid-client';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const SEP = '#'.repeat(80);
const TEXT = `${SEP}
# :: snt1
Index: 1 2
Words: Ali geldi

# sentence level graph:
(s1g / gel-01
    :ARG1 (s1a / person))

# alignment:
s1g: 2-2
s1a: 1-1

# document level annotation:
(s1s0 / sentence)
`;

const MAINTAINER = { id: 'm@x' };
const WRITER = { id: 'w@x' };
const PROJECT = { id: 'p', maintainers: [MAINTAINER.id], writers: [WRITER.id] };

const nodeLayerOf = (raw) => raw.textLayers[0].tokenLayers.find((l) => l.config?.umr?.nodes);

function load(user, declared) {
  const raw = rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));
  if (declared !== undefined) {
    const layer = nodeLayerOf(raw);
    layer.config = {
      ...layer.config,
      plaid: { ...layer.config?.plaid, [PLAIN_EDITS_KEY]: declared },
    };
  }
  const { client, calls, requests } = recordingClient();
  const doc = new UmrDocument({ raw, client, project: PROJECT, user });
  doc._reload = async () => {};
  return { doc, calls, requests, raw };
}

const declarations = (calls) =>
  calls.filter((c) => c.name === 'tokenLayers.setConfig' && c.args[2] === PLAIN_EDITS_KEY);

test("a maintainer's open declares plainEdits on the node layer, in a batch, naming what it read", async () => {
  const { doc, calls, requests, raw } = load(MAINTAINER);
  await doc._reconcile();
  const made = declarations(calls);
  assert.deepEqual(
    made.map((c) => c.args),
    [
      [
        nodeLayerOf(raw).id,
        PLAID_NAMESPACE,
        PLAIN_EDITS_KEY,
        true,
        undefined,
        { expected: undefined },
      ],
    ],
  );
  assert.ok(!requests.some((r) => r.name === 'tokenLayers.setConfig'), 'sent in a batch');
});

test('a node layer that declares it already is left alone', async () => {
  const { doc, calls } = load(MAINTAINER, true);
  await doc._reconcile();
  assert.deepEqual(declarations(calls), []);
});

test('a writer who is not a maintainer declares nothing', async () => {
  const { doc, calls } = load(WRITER);
  await doc._reconcile();
  assert.deepEqual(declarations(calls), []);
});
