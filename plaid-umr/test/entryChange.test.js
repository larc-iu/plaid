// A node's concept picked from a vocabulary entry, after the entry changed
// in IGT (the owner's ruling of 2026-09-28): the node is warned about, on
// the canvas and in Validation, and takes the entry's new value only when a
// person asks. An entry that is gone is forgotten on open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROV, provState, PROV_STATES } from '@larc-iu/plaid-client';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument, readEntryLexicon } from '../src/domain/UmrDocument.js';
import { validateProject } from '../src/domain/validationQueries.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const TEXT = `################################################################################
# :: snt1
Index: 1 2 3
Words: Ali kitap verdi

# sentence level graph:
(s1v / ver-01
    :ARG0 (s1a / person)
    :ARG1 (s1k / kitap))

# alignment:
s1v: 3-3
s1a: 1-1
s1k: 2-2

# document level annotation:
(s1s0 / sentence)

################################################################################
# :: snt2
Index: 1 2
Words: kitap verdi

# sentence level graph:
(s2v / ver-01
    :ARG1 (s2k / kitap))

# alignment:
s2v: 2-2
s2k: 1-1

# document level annotation:
(s2s0 / sentence)
`;

const VOCAB = {
  id: 'v1',
  name: 'Turkish',
  items: [
    { id: 'ver', form: 'ver', metadata: { umr: { roleset: 'ver-02' } } },
    { id: 'kitap', form: 'kitab', metadata: {} },
  ],
};

// The nodes named, picked from the entries given: `{ s1v: 'ver' }`.
function load(entries, { vocabs = [VOCAB], failing = [] } = {}) {
  const plan = planImport(parseUmrFile(TEXT).sentences, []);
  const raw = rawFromPlan(plan);
  raw.textLayers[0].tokenLayers
    .find((l) => l.config?.umr?.nodes)
    .spanLayers[0].spans.forEach((s) => {
      const entry = entries[s.metadata.umr.var];
      if (entry) s.metadata.umr.entry = entry;
      s.metadata = { [PROV.key]: PROV.INFERRED, [PROV.sourceKey]: 'service:x', ...s.metadata };
    });
  const { client, calls } = recordingClient();
  client.vocabLayers = {
    get: async (id) => {
      if (failing.includes(id)) throw new Error('unreadable');
      return vocabs.find((v) => v.id === id);
    },
  };
  const project = {
    id: 'p',
    vocabs: vocabs.map((v) => ({ id: v.id })).concat(failing.map((id) => ({ id }))),
  };
  const doc = new UmrDocument({ raw, client, project, user: null });
  doc._reload = async () => {};
  doc.onError = (msg) => {
    throw new Error(msg);
  };
  return { doc, calls };
}

const byVar = (doc, v) => [...doc.graph.nodesById.values()].find((n) => n.var === v);
const operations = (calls) => calls.filter((c) => c.name === 'operation').map((c) => c.args[0]);

test('a node whose entry now reads another roleset is warned about, and one that agrees is not', async () => {
  const { doc } = load({ s1v: 'ver', s1k: 'kitap' });
  assert.equal(doc.problems.filter((p) => p.code === 'entry-changed').length, 0, 'before the read');
  await doc.loadLexicon();
  const found = doc.problems.filter((p) => p.code === 'entry-changed');
  assert.deepEqual(
    found.map((p) => [p.sentence, p.var, p.level, p.message]),
    [
      [1, 's1v', 'warning', 's1v was picked from ver, now ver-02.'],
      // The entry renamed to its own new headword is named by the old one.
      [1, 's1k', 'warning', 's1k was picked from kitap, now kitab.'],
    ],
  );
  // The sentence badge and the node's mark read the same list.
  assert.equal(doc.problemsBySentence.get(1).filter((p) => p.code === 'entry-changed').length, 2);
  assert.deepEqual(doc.entryChange(byVar(doc, 's1v').id), {
    entryId: 'ver',
    form: 'ver',
    from: 'ver-01',
    to: 'ver-02',
  });
  // s2v was typed, not picked: nothing to compare.
  assert.equal(doc.entryChange(byVar(doc, 's2v').id), null);
});

test('taking the new value changes the one node, stamped, as one operation', async () => {
  const { doc, calls } = load({ s1v: 'ver', s2v: 'ver' });
  await doc.loadLexicon();
  const node = byVar(doc, 's1v');
  assert.equal(doc.entryChangeCount(node.id), 2);
  assert.equal(await doc.takeEntryValue(node.id), true);
  assert.equal(byVar(doc, 's1v').concept, 'ver-02');
  assert.equal(byVar(doc, 's2v').concept, 'ver-01');
  // A person's edit: it settles the drafted node, and keeps the entry.
  assert.equal(provState(byVar(doc, 's1v').metadata), PROV_STATES.VERIFIED);
  assert.equal(byVar(doc, 's1v').metadata.umr.entry, 'ver');
  assert.deepEqual(operations(calls), ['Take ver-02 from the entry ver for s1v']);
  assert.deepEqual(
    calls.filter((c) => c.name === 'spans.update').map((c) => c.args),
    [[node.id, 'ver-02']],
  );
  assert.equal(doc.entryChange(node.id), null);
  assert.equal(
    doc.problems
      .filter((p) => p.code === 'entry-changed')
      .map((p) => p.var)
      .join(),
    's2v',
  );
});

test('taking the new value everywhere changes every node picked from the entry', async () => {
  const { doc, calls } = load({ s1v: 'ver', s2v: 'ver', s1k: 'kitap' });
  await doc.loadLexicon();
  assert.equal(await doc.takeEntryValue(byVar(doc, 's2v').id, { everywhere: true }), true);
  assert.equal(byVar(doc, 's1v').concept, 'ver-02');
  assert.equal(byVar(doc, 's2v').concept, 'ver-02');
  // Another entry's node is not touched.
  assert.equal(byVar(doc, 's1k').concept, 'kitap');
  assert.deepEqual(operations(calls), ['Take ver-02 from the entry ver for 2 nodes']);
  // Nothing left to take.
  assert.equal(await doc.takeEntryValue(byVar(doc, 's2v').id), false);
});

test('reconcile forgets an entry that is gone, only on a complete read', async () => {
  const gone = load({ s1v: 'deleted', s1k: 'kitap' });
  const result = await gone.doc._reconcile();
  assert.equal(result.unlinked, 1);
  // Only the entry: a repair vouches for nothing, so no stamp rides along.
  const patches = gone.calls.filter((c) => c.name === 'spans.patchMetadata');
  assert.deepEqual(
    patches.map((c) => c.args),
    [[byVar(gone.doc, 's1v').id, [{ op: 'delete', path: ['umr', 'entry'] }]]],
  );
  assert.equal(
    gone.doc.describeReconcile(result),
    'Repaired: unlinked 1 node from a deleted vocabulary entry',
  );

  // A vocabulary that could not be read may hold the entry.
  const unread = load({ s1v: 'deleted' }, { failing: ['v2'] });
  const again = await unread.doc._reconcile();
  assert.deepEqual(again, { findings: [] });
  assert.equal(unread.calls.length, 0);
});

test('a project that does not say which vocabularies it has reads no lexicon', async () => {
  assert.equal(await readEntryLexicon({}, { id: 'p' }), null);
  assert.equal(await readEntryLexicon(null, { vocabs: [] }), null);
});

test('the Validation tab reports a node whose entry changed', async () => {
  const { doc } = load({ s2v: 'ver' });
  const raw = doc._raw;
  const client = {
    projects: { listDocuments: async () => [{ id: 'd', name: 'Turkish' }] },
    documents: { get: async () => structuredClone(raw) },
    vocabLayers: { get: async () => VOCAB },
  };
  const rows = await validateProject(client, 'p', { project: { id: 'p', vocabs: [{ id: 'v1' }] } });
  assert.deepEqual(
    rows.filter((r) => r.code === 'entry-changed').map((r) => [r.sentenceIndex, r.var, r.message]),
    [[2, 's2v', 's2v was picked from ver, now ver-02.']],
  );
  // Without the project there is no lexicon, and no such row.
  const without = await validateProject(client, 'p', {});
  assert.equal(without.filter((r) => r.code === 'entry-changed').length, 0);
});
