// Relabelling an edge from a cycle role (`:quote`, `:modal-predicate`) to any
// other closes the cycle that role was allowed to, and is refused as adding
// that edge would be. Core no longer holds `acyclic` on UMR relations, so the
// editor's check is the rule (REV-FX-CORE, client gap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const SEP = '#'.repeat(80);
const TEXT = `${SEP}
# :: snt1
Index: 1 2 3
Words: Ali dedi .

# sentence level graph:
(s1d / de-01
    :ARG0 (s1a / person)
    :ARG1 (s1b / believe-01
        :ARG0 s1a
        :quote s1d))

# alignment:
s1d: 2-2
s1a: 1-1
s1b: 0-0

# document level annotation:
(s1s0 / sentence)
`;

function load() {
  const raw = rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));
  const { client, calls } = recordingClient();
  client.relations.update = async (...args) => calls.push({ name: 'relations.update', args });
  const doc = new UmrDocument({ raw, client });
  doc._reload = async () => {};
  const errors = [];
  doc.onError = (msg) => errors.push(msg);
  return { doc, calls, errors };
}

const edge = (doc, role) =>
  [...doc.graph.nodesById.values()].flatMap((n) => n.out).find((e) => e.role === role);

test('a :quote back into the root relabelled as another role is refused', async () => {
  const { doc, calls, errors } = load();
  assert.equal(await doc.setRole(edge(doc, ':quote').id, ':ARG2'), false);
  assert.match(errors[0], /would close a cycle/);
  assert.equal(calls.filter((c) => c.name.startsWith('relations.')).length, 0);
});

test('a relabel between two cycle roles, or of an edge on no cycle, goes through', async () => {
  const { doc } = load();
  assert.equal(await doc.setRole(edge(doc, ':quote').id, ':modal-predicate'), true);
  const { doc: other } = load();
  assert.equal(await other.setRole(edge(other, ':ARG0').id, ':actor'), true);
});
