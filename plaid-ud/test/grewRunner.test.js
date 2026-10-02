import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMetadataOps } from '@larc-iu/plaid-client';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps, batchOf } from './helpers/stubClient.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';
import { parseGrs } from '../src/grew/parser.js';
import { planRewrite, applyRewrite, applySummary } from '../src/grew/rewrite/runner.js';

// "loudly" has no LEMMA and no place in the tree, so the import gives it no
// Lemma span at all: a rule that hands IT an edge needs one created first. (A
// word with no lemma but a head, like "saw", gets a null-valued span on
// import, because a relation hangs off one.)
const CONLLU = [
  '# text = the dog saw a cat loudly',
  '1\tthe\tthe\tDET\t_\tDefinite=Def\t2\tdet\t_\t_',
  '2\tdog\tdog\tNOUN\t_\t_\t3\tnsubj\t_\t_',
  '3\tsaw\t_\tVERB\t_\t_\t0\troot\t_\t_',
  '4\ta\ta\tDET\t_\tDefinite=Ind\t5\tdet\t_\t_',
  '5\tcat\tcat\tNOUN\t_\t_\t2\tnmod\t_\t_',
  '6\tloudly\t_\tADV\t_\t_\t_\t_\t_\t_',
].join('\n');

// A recording client: every write lands in `calls` when its batch submits,
// and the submit hands back a fresh id per op, as the server would. Strict
// mode is recorded too; a batch for `failOn` is refused with a 409, as the
// server refuses a stale document version, and writes nothing.
function stubClient(...raws) {
  const c = {
    calls: [],
    strict: [],
    failOn: null,
    // Ops of every batch that went out, and a hook to refuse one (a 500).
    batches: [],
    refuse: null,
    locks: [],
    query: async () => ({ results: raws.map((r) => [r.id, 1]) }),
    documents: {
      get: async (id) => structuredClone(raws.find((r) => r.id === id)),
      locked: async (id, fn) => {
        c.locks.push(['lock', id]);
        try {
          return await fn();
        } finally {
          c.locks.push(['unlock', id]);
        }
      },
    },
    projects: { listDocuments: async () => raws.map((r) => ({ id: r.id })) },
    enterStrictMode: (id) => {
      c.strict.push(['enter', id]);
      c._strictDoc = id;
    },
    exitStrictMode: () => {
      c.strict.push(['exit']);
      c._strictDoc = null;
    },
    batched: async (fn) => {
      const b = batchOf(c);
      try {
        await fn(b);
      } catch (e) {
        b.abort();
        throw e;
      }
      if (c._strictDoc && c._strictDoc === c.failOn) {
        b.abort();
        throw Object.assign(new Error('document version mismatch'), { status: 409 });
      }
      const ops = b.operations.map((o) => o.op);
      if (c.refuse?.(ops)) {
        b.abort();
        throw Object.assign(new Error('HTTP 500 boom'), { status: 500 });
      }
      c.batches.push(ops);
      await b.submit();
      return ops.map((op, i) => ({ status: 200, body: { id: `${op}-${i}` } }));
    },
  };
  const rec =
    (op) =>
    (...args) => {
      c.calls.push({ op, args });
    };
  c.tokens = { delete: rec('tokens.delete') };
  c.spans = {
    create: rec('spans.create'),
    update: rec('spans.update'),
    delete: rec('spans.delete'),
    patchMetadata: rec('spans.patchMetadata'),
  };
  c.relations = {
    create: rec('relations.create'),
    update: rec('relations.update'),
    delete: rec('relations.delete'),
    setSource: rec('relations.setSource'),
    setTarget: rec('relations.setTarget'),
    patchMetadata: rec('relations.patchMetadata'),
  };
  return withOps(c);
}

const setup = () => {
  const raw = rawDocFromConllu(CONLLU, 'doc1');
  // "a" was tagged by a parser: the verifier's rewrite confirms it.
  const aUpos = raw.textLayers[0].tokenLayers[2].spanLayers.find((l) => l.config.ud.upos).spans[3];
  aUpos.metadata = { prov: 'inferred', provSource: 'parser' };
  const client = stubClient(raw);
  const project = {
    id: 'p1',
    name: 'P',
    maintainers: [],
    writers: [],
    readers: [],
    textLayers: raw.textLayers,
  };
  return { raw, client, project, layerInfo: getUdLayerInfo(raw) };
};

test('plan: one row per rewritten sentence, with change lines and counts', async () => {
  const { client, project, layerInfo } = setup();
  const grs = parseGrs('pattern { X [upos=DET] } commands { X.upos = PRON }');
  const progress = [];
  const plan = await planRewrite(client, { project, user: null, layerInfo, grs }, (t) =>
    progress.push(t),
  );
  assert.equal(plan.documentsVisited, 1);
  assert.equal(plan.rows.length, 1);
  const [row] = plan.rows;
  assert.equal(row.docName, 'doc1');
  assert.equal(row.text, 'the dog saw a cat loudly');
  assert.equal(row.applications, 2);
  assert.deepEqual(
    row.changes.map((c) => c.text),
    ['the: upos DET → PRON', 'a: upos DET → PRON'],
  );
  assert.equal(row.error, null);
  assert.deepEqual(progress, ['Loading document 1 of 1…', '']);

  assert.equal(client.calls.length, 0); // planning writes nothing
});

test('plan: a rule that fails on a sentence yields an error row, nothing else', async () => {
  const { client, project, layerInfo } = setup();
  const grs = parseGrs('pattern { X [upos=DET] } commands { X.upos = X.Number }');
  const plan = await planRewrite(client, { project, user: null, layerInfo, grs });
  assert.equal(plan.rows.length, 1);
  assert.match(plan.rows[0].error, /X.Number is undefined/);
  assert.equal(plan.rows[0].writes, null);
});

test('apply: updates carry the verifier stamp, all under one operation', async () => {
  const { client, project, layerInfo } = setup();
  const grs = parseGrs('pattern { X [upos=DET] } commands { X.upos = PRON }');
  const plan = await planRewrite(client, { project, user: null, layerInfo, grs });
  const out = await applyRewrite(client, { rows: plan.rows, docs: plan.docs, label: 'Rewrite' });
  assert.deepEqual(out, { docsChanged: 1, sentencesChanged: 1, failed: null });
  // Every document is written in strict mode, and strict mode is left after.
  assert.deepEqual(client.strict, [['enter', 'doc1-id'], ['exit']]);
  assert.deepEqual(
    client.calls.map((c) => c.op),
    ['spans.update', 'spans.update', 'spans.patchMetadata'],
  );
  assert.deepEqual(client.calls[1].args[1], 'PRON');
  // The machine-made tag is confirmed by the person's rewrite.
  assert.equal(client.calls[2].args[0], client.calls[1].args[0]);
  assert.deepEqual(client.calls[2].args[1], [{ op: 'set', path: ['provConfirmed'], value: true }]);
});

// A study reads the audit log: a rewrite is one bulk edit, named as a Grew
// rewrite.
test('apply: the operation is a bulk edit naming the Grew rewrite', async () => {
  const { client, project, layerInfo } = setup();
  const grs = parseGrs('pattern { X [upos=DET] } commands { X.upos = PRON }');
  const plan = await planRewrite(client, { project, user: null, layerInfo, grs });
  await applyRewrite(client, { rows: plan.rows, docs: plan.docs, label: 'Rewrite' });
  assert.deepEqual(client.operations, [
    { message: 'Rewrite', kind: 'bulk-edit', ref: 'action:grew-rewrite' },
  ]);
});

test('apply: the lemma spans, the token deletes and the relations go in one batch', async () => {
  const { client, project, layerInfo } = setup();
  // "loudly" has no lemma and no place in the tree, so it has no Lemma span
  // for a relation to hang on; give it the advmod and drop "the".
  const grs = parseGrs(`pattern { V [upos=VERB]; A [upos=ADV]; D [form="the"] }
    commands { add_edge V -[advmod]-> A; del_node D } strat main { rule }`);
  const plan = await planRewrite(client, { project, user: null, layerInfo, grs });
  assert.deepEqual(
    plan.rows[0].changes.map((c) => c.text),
    ['the: word deleted', 'saw → loudly: advmod added', 'loudly: lemma loudly added'],
  );
  await applyRewrite(client, { rows: plan.rows, docs: plan.docs, label: 'Rewrite' });
  assert.deepEqual(client.batches, [['spans.create', 'tokens.delete', 'relations.create']]);
  assert.deepEqual(client.locks, []);
  const lemmaCreate = client.calls[0];
  assert.equal(lemmaCreate.args[2], 'loudly');
  const relCreate = client.calls[2];
  // The TARGET is the word that needed the span, named by the id minted for
  // the create above.
  assert.ok(lemmaCreate.args[5].id);
  assert.equal(relCreate.args[2], lemmaCreate.args[5].id);
  assert.equal(relCreate.args[3], 'advmod');
  // The surface token of a one-word token is what gets deleted.
  const theWord = plan.rows[0].nodes.get([...plan.rows[0].nodes.keys()][1]); // [0] is the anchor
  assert.equal(client.calls[1].args[0], theWord.wordId);
});

test('apply: a document changed since the preview stops the run after the ones before it', async () => {
  const raw1 = rawDocFromConllu(CONLLU, 'doc1');
  const raw2 = rawDocFromConllu(CONLLU, 'doc2');
  const client = stubClient(raw1, raw2);
  const project = {
    id: 'p1',
    name: 'P',
    maintainers: [],
    writers: [],
    readers: [],
    textLayers: raw1.textLayers,
  };
  const grs = parseGrs('pattern { X [upos=DET] } commands { X.upos = PRON }');
  const plan = await planRewrite(client, {
    project,
    user: null,
    layerInfo: getUdLayerInfo(raw1),
    grs,
  });
  assert.equal(plan.rows.length, 2);
  client.failOn = 'doc2-id';
  const out = await applyRewrite(client, { rows: plan.rows, docs: plan.docs, label: 'Rewrite' });
  assert.equal(out.docsChanged, 1);
  assert.equal(out.sentencesChanged, 1);
  assert.deepEqual(out.failed, {
    docId: 'doc2-id',
    docName: 'doc2',
    status: 409,
    message: 'document version mismatch',
    partial: false,
    unsure: false,
  });
  assert.deepEqual(client.strict, [['enter', 'doc1-id'], ['exit'], ['enter', 'doc2-id'], ['exit']]);
  // The operation was still closed.
  assert.equal(client.operationGroup, null);
});

test('apply as a reviewed contributor: creates and edits are marked contributed', async () => {
  const { raw, client, project } = setup();
  project.config = { plaid: { review: { users: ['u1'] } } };
  const user = { id: 'u1', isAdmin: false };
  const grs = parseGrs('pattern { X [upos=DET, !Seen] } commands { X.upos = PRON; X.Seen = Yes }');
  const plan = await planRewrite(client, { project, user, layerInfo: getUdLayerInfo(raw), grs });
  await applyRewrite(client, { rows: plan.rows, docs: plan.docs, label: 'Rewrite' });
  const ops = client.calls.map((c) => c.op);
  // Two DET words: an update + its stamp and a create each.
  assert.deepEqual(ops.filter((o) => o === 'spans.update').length, 2);
  assert.deepEqual(ops.filter((o) => o === 'spans.patchMetadata').length, 2);
  assert.deepEqual(ops.filter((o) => o === 'spans.create').length, 2);
  const stamp = applyMetadataOps(
    {},
    client.calls.find((c) => c.op === 'spans.patchMetadata').args[1],
  );
  assert.equal(stamp.prov, 'contributed');
  assert.equal(stamp.provSource, 'user:u1');
  const create = client.calls.find((c) => c.op === 'spans.create').args[3];
  assert.equal(create.prov, 'contributed');
});

// A closed vocabulary governs what a RULE WRITES, not what the sentence
// already holds. Checking the whole rewritten graph meant one parser-written
// off-list tag anywhere in a sentence blocked a rule that never touched that
// column, and deselected the row.
const closedUposSetup = () => {
  const raw = rawDocFromConllu(
    [
      '# text = the dog saw a cat',
      '1\tthe\tthe\tDET\t_\t_\t2\tdet\t_\t_',
      '2\tdog\tdog\tNOUN\t_\t_\t3\tnsubj\t_\t_',
      '3\tsaw\tsee\tWIDGET\t_\t_\t0\troot\t_\t_',
      '4\ta\ta\tDET\t_\t_\t5\tdet\t_\t_',
      '5\tcat\tcat\tNOUN\t_\t_\t2\tnmod\t_\t_',
    ].join('\n'),
    'doc1',
  );
  const upos = raw.textLayers[0].tokenLayers[2].spanLayers.find((l) => l.config.ud.upos);
  upos.config.ud.vocabMode = 'closed';
  const client = stubClient(raw);
  const project = {
    id: 'p1',
    name: 'P',
    maintainers: [],
    writers: [],
    readers: [],
    textLayers: raw.textLayers,
  };
  return { client, project, layerInfo: getUdLayerInfo(raw) };
};

test('plan: an off-list value the rule never touches does not block the row', async () => {
  const { client, project, layerInfo } = closedUposSetup();
  const grs = parseGrs(
    'pattern { X [upos=NOUN] } without { X [lemma="x"] } commands { X.lemma = "x" }',
  );
  const plan = await planRewrite(client, { project, user: null, layerInfo, grs });
  const [row] = plan.rows;
  assert.equal(row.error, null);
  assert.equal(row.applications, 2);
});

test('plan: an off-list value the rule DOES write still refuses the row', async () => {
  const { client, project, layerInfo } = closedUposSetup();
  const grs = parseGrs('pattern { X [upos=DET] } commands { X.upos = GADGET }');
  const plan = await planRewrite(client, { project, user: null, layerInfo, grs });
  const [row] = plan.rows;
  assert.match(row.error, /GADGET/);
});

test('plan: a rule that applies and leaves nothing to write yields no row', async () => {
  const raw = rawDocFromConllu(CONLLU, 'doc1', { enhanced: true });
  const client = stubClient(raw);
  const project = {
    id: 'p1',
    name: 'P',
    maintainers: [],
    writers: [],
    readers: [],
    textLayers: raw.textLayers,
  };
  // The tree gives the enhanced graph this edge already.
  const grs = parseGrs(
    'pattern { N -[det]-> D } without { N -[E:det]-> D } commands { add_edge N -[E:det]-> D }',
  );
  const plan = await planRewrite(client, {
    project,
    user: null,
    layerInfo: getUdLayerInfo(raw),
    grs,
  });
  assert.deepEqual(plan.rows, []);
});

// "the" deleted and "loudly" given an edge it needs a lemma span for: the
// lemma spans go first, the rest in one batch after.
const LEMMA_AND_DELETE = `pattern { V [upos=VERB]; A [upos=ADV]; D [form="the"] }
  commands { add_edge V -[advmod]-> A; del_node D } strat main { rule }`;

test('apply: a document with no lemma to create is one batch, with no lock', async () => {
  const { client, project, layerInfo } = setup();
  const grs = parseGrs(`pattern { D [form="the"]; X [upos=DET, form="a"] }
    commands { del_node D; X.upos = PRON } strat main { rule }`);
  const plan = await planRewrite(client, { project, user: null, layerInfo, grs });
  const out = await applyRewrite(client, { rows: plan.rows, docs: plan.docs, label: 'Rewrite' });
  assert.equal(out.failed, null);
  assert.equal(client.batches.length, 1);
  assert.equal(client.batches[0][0], 'tokens.delete');
  assert.ok(client.batches[0].includes('spans.update'));
  assert.deepEqual(client.locks, []);
});

test('apply: a refused batch writes nothing, the lemma spans included', async () => {
  const { client, project, layerInfo } = setup();
  const plan = await planRewrite(client, {
    project,
    user: null,
    layerInfo,
    grs: parseGrs(LEMMA_AND_DELETE),
  });
  client.refuse = (ops) => ops.includes('tokens.delete');
  const out = await applyRewrite(client, { rows: plan.rows, docs: plan.docs, label: 'Rewrite' });
  assert.equal(out.docsChanged, 0);
  assert.equal(out.failed.status, 500);
  assert.equal(out.failed.partial, false);
  // The one batch, lemma span and all, was refused whole.
  assert.deepEqual(client.batches, []);
  assert.deepEqual(client.locks, []);
});

test('applySummary: the reason ends in one full stop, and a first-document refusal names no count', () => {
  const reason = () => 'The server hit an unexpected error. Try again in a moment.';
  const failed = { docId: 'd', docName: 'doc1', status: 500, message: 'x', partial: false };
  assert.equal(
    applySummary({ docsChanged: 0, sentencesChanged: 0, failed }, reason),
    'Stopped at doc1: The server hit an unexpected error. Try again in a moment. doc1 is unchanged.',
  );
  assert.equal(
    applySummary(
      { docsChanged: 2, sentencesChanged: 3, failed: { ...failed, partial: true } },
      reason,
    ),
    'Stopped at doc1: The server hit an unexpected error. Try again in a moment. doc1 is partly changed. Changed 3 sentences in 2 documents before it.',
  );
  assert.equal(
    applySummary(
      { docsChanged: 0, sentencesChanged: 0, failed: { ...failed, status: 409 } },
      reason,
    ),
    'Stopped at doc1: it changed since the preview. doc1 is unchanged.',
  );
  assert.equal(
    applySummary({ docsChanged: 1, sentencesChanged: 1, failed: null }, reason),
    'Changed 1 sentence in 1 document.',
  );
});

// A request whose answer never came (status 0) may have landed. The toast must
// not say the document is unchanged.
test('apply: a batch whose answer is lost does not report the document unchanged', async () => {
  for (const grs of [
    `pattern { D [form="the"]; X [upos=DET, form="a"] }
      commands { del_node D; X.upos = PRON } strat main { rule }`,
    LEMMA_AND_DELETE,
  ]) {
    const { client, project, layerInfo } = setup();
    const plan = await planRewrite(client, { project, user: null, layerInfo, grs: parseGrs(grs) });
    const batched = client.batched;
    // The first request goes out and its answer is lost.
    let first = true;
    client.batched = async (fn) => {
      if (!first) return batched(fn);
      first = false;
      throw Object.assign(new Error('Request timed out'), { status: 0 });
    };
    const out = await applyRewrite(client, { rows: plan.rows, docs: plan.docs, label: 'Rewrite' });
    assert.equal(out.failed.status, 0);
    assert.doesNotMatch(
      applySummary(out, () => 'Could not reach the server.'),
      /unchanged/,
    );
  }
});

test('applySummary: a document whose outcome is unknown may have changed', () => {
  const failed = {
    docId: 'd',
    docName: 'doc1',
    status: 0,
    message: 'x',
    partial: false,
    unsure: true,
  };
  assert.equal(
    applySummary(
      { docsChanged: 0, sentencesChanged: 0, failed },
      () => 'Could not reach the server.',
    ),
    'Stopped at doc1: Could not reach the server. doc1 may have changed.',
  );
});

test('apply: every relation delete goes before an edge is moved or made, so no request ends on a word with two heads', async () => {
  const { client, project, layerInfo } = setup();
  // "a" loses its head and takes "the"'s instead. The diff meets the moved
  // edge (the's, line 1) before the dropped one (a's, line 4), and the batch
  // still drops a's head first.
  const grs = parseGrs(`pattern { T [form="the"]; A [form="a"]; e: C -[det]-> A }
    commands { del_edge e; shift_in T ==> A } strat main { rule }`);
  const plan = await planRewrite(client, { project, user: null, layerInfo, grs });
  await applyRewrite(client, { rows: plan.rows, docs: plan.docs, label: 'Rewrite' });
  const ops = client.batches.flat().filter((op) => op.startsWith('relations.'));
  assert.deepEqual(ops, ['relations.delete', 'relations.setTarget']);
});
