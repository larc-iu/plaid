// A "Text only" copy for a second annotator (umr-collab-blank-copy): core's
// copy, then UMR's own graph taken off the copy, as one History entry. The
// words, the glosses and the sentence records stay.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyMetadataOps } from '@larc-iu/plaid-client';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import {
  copyTextOnly,
  CopyKeptGraphs,
  leaveOutGraphs,
  textOnlyPlan,
} from '../src/domain/textOnlyCopy.js';
import { rawFromPlan } from './rawFromPlan.js';

const SEPARATOR = '#'.repeat(80);
const block = (i, words, graph, alignment, doc = '') =>
  [
    SEPARATOR,
    `# :: snt${i}`,
    `Index: ${words
      .split(' ')
      .map((_, k) => k + 1)
      .join(' ')}`,
    `Words: ${words}`,
    '',
    '# sentence level graph:',
    graph,
    '',
    '# alignment:',
    alignment,
    '',
    '# document level annotation:',
    doc,
    '',
    '',
  ].join('\n');

// Sentence 1 has a graph and a document-level relation, sentence 2 a graph
// the reader could not parse, kept as text.
const FILE =
  block(
    1,
    'the cat sleeps',
    '(s1s / sleep-01\n    :ARG0 (s1c / cat))',
    's1s: 3-3\ns1c: 2-2',
    '(s1s0 / sentence\n    :temporal ((document-creation-time :before s1s)))',
  ) + block(2, 'the dog barks', '((s2b / bark-01', 's2b: 3-3');

const REPORT = { version: 4, at: '2026-09-28T05:22:03Z', against: { id: 'd2', name: 'lunch' } };

// The sentences' records: the tokens of the node layer that carry metadata.
const recordsOf = (raw) => raw.textLayers[0].tokenLayers[2].tokens.filter((t) => t.metadata?.umr);
const anchorsOf = (raw) => raw.textLayers[0].tokenLayers[2].tokens.filter((t) => !t.metadata?.umr);

function annotatedRaw() {
  const raw = rawFromPlan(planImport(parseUmrFile(FILE).sentences, []));
  raw.metadata = { umr: { adjudication: REPORT }, other: { kept: true } };
  const sentences = raw.textLayers[0].tokenLayers[0].tokens;
  sentences[0].metadata = { umr: { adjudication: { at: REPORT.at, index: 1 } } };
  // A relation the file wrote onto a node of the unreadable graph, held by name.
  recordsOf(raw)[1].metadata.umr.held = [
    { source: 's1s', rel: ':before', target: 's2b', group: 'temporal' },
  ];
  return raw;
}

// What the server does with the plan: node tokens go and take their spans
// and relations with them, and the metadata ops land.
function applyPlan(raw, plan) {
  const out = structuredClone(raw);
  const [text] = out.textLayers;
  const nodeLayer = text.tokenLayers[2];
  const gone = new Set(plan.nodeTokenIds);
  nodeLayer.tokens = nodeLayer.tokens.filter((t) => !gone.has(t.id));
  const [concepts] = nodeLayer.spanLayers;
  concepts.spans = concepts.spans.filter((s) => s.tokens.some((t) => !gone.has(t)));
  const alive = new Set(concepts.spans.map((s) => s.id));
  concepts.relationLayers.forEach((l) => {
    l.relations = l.relations.filter((r) => alive.has(r.source) && alive.has(r.target));
  });
  const updates = new Map(plan.sentenceUpdates.map((u) => [u.id, u.metadata]));
  [...text.tokenLayers[0].tokens, ...nodeLayer.tokens].forEach((t) => {
    if (updates.has(t.id)) t.metadata = applyMetadataOps(t.metadata, updates.get(t.id));
  });
  out.metadata = applyMetadataOps(out.metadata, plan.documentOps);
  return out;
}

describe('what a text-only copy leaves out', () => {
  test('every node goes, and the words and the sentence records stay', () => {
    const raw = annotatedRaw();
    const before = new UmrDocument({ raw });
    assert.ok(before.graph.nodesById.size > 0);

    const plan = textOnlyPlan(raw);
    assert.deepEqual(
      plan.nodeTokenIds,
      anchorsOf(raw).map((t) => t.id),
    );
    const after = new UmrDocument({ raw: applyPlan(raw, plan) });
    assert.equal(after.graph.nodesById.size, 0);
    assert.deepEqual(
      after.sentences.map((s) => s.words.map((w) => w.text)),
      before.sentences.map((s) => s.words.map((w) => w.text)),
    );
    // The file's own sentence records are the text, not the graph.
    const [s1, s2] = recordsOf(applyPlan(raw, plan));
    assert.equal(s1.metadata.umr.snt, recordsOf(raw)[0].metadata.umr.snt);
    assert.ok('snt' in s2.metadata.umr);
  });

  test('a graph kept as text, its held relations and the comparison report go too', () => {
    const raw = annotatedRaw();
    const [s1] = raw.textLayers[0].tokenLayers[0].tokens;
    const [, r2] = recordsOf(raw);
    assert.ok(r2.metadata.umr.rawGraph, 'the fixture keeps sentence 2 as text');
    const plan = textOnlyPlan(raw);
    assert.deepEqual(plan.sentenceUpdates, [
      {
        id: r2.id,
        metadata: [
          { op: 'delete', path: ['umr', 'rawGraph'] },
          { op: 'delete', path: ['umr', 'rawAlignment'] },
          { op: 'delete', path: ['umr', 'held'] },
        ],
      },
      { id: s1.id, metadata: [{ op: 'delete', path: ['umr', 'adjudication'] }] },
    ]);
    assert.deepEqual(plan.documentOps, [{ op: 'delete', path: ['umr', 'adjudication'] }]);
    const after = applyPlan(raw, plan);
    assert.deepEqual(after.metadata, { umr: {}, other: { kept: true } });
    assert.equal(new UmrDocument({ raw: after }).toUmr().includes('s2b'), false);
  });

  test('a document with no graph has nothing to leave out', () => {
    const raw = applyPlan(annotatedRaw(), textOnlyPlan(annotatedRaw()));
    assert.deepEqual(textOnlyPlan(raw), {
      nodeTokenIds: [],
      sentenceUpdates: [],
      documentOps: [],
    });
  });
});

// A client that records the operation, the copy's read and the batch.
function fakeClient(raw, { batchFails = null, deleteFails = null } = {}) {
  const log = [];
  const client = {
    log,
    withOperation: async (label, fn) => {
      log.push(['begin', label]);
      try {
        return await fn(() => {});
      } finally {
        log.push(['end']);
      }
    },
    documents: {
      get: async (id, includeBody) => {
        log.push(['get', id, includeBody]);
        return raw;
      },
      delete: async (id, label) => {
        log.push(['delete', id, label]);
        if (deleteFails) throw deleteFails;
      },
    },
    batched: async (fn) => {
      const ops = [];
      const b = {
        tokens: {
          bulkDelete: (ids) => ops.push(['tokens.bulkDelete', ids.length]),
          bulkUpdate: (entries) => ops.push(['tokens.bulkUpdate', entries.length]),
        },
        documents: { patchMetadata: (id, o) => ops.push(['documents.patchMetadata', id, o]) },
      };
      await fn(b);
      log.push(['batch', ops]);
      if (batchFails) throw batchFails;
      return ops.map(() => ({}));
    },
  };
  return client;
}

const docThatCopies = (result) => ({
  name: 'lunch',
  copyTo: async (name) => result && { ...result, name },
});

describe('copying as text only', () => {
  test('the copy and the graphs it leaves out are one History entry', async () => {
    const raw = annotatedRaw();
    const client = fakeClient(raw);
    const created = await copyTextOnly(client, docThatCopies({ id: 'd9' }), ' lunch (second) ');
    assert.deepEqual(created, { id: 'd9', name: 'lunch (second)' });
    const nodes = anchorsOf(raw).length;
    assert.deepEqual(client.log, [
      ['begin', 'Copy "lunch" as "lunch (second)", text only'],
      ['get', 'd9', true],
      [
        'batch',
        [
          ['tokens.bulkDelete', nodes],
          ['tokens.bulkUpdate', 2],
          ['documents.patchMetadata', 'd9', [{ op: 'delete', path: ['umr', 'adjudication'] }]],
        ],
      ],
      ['end'],
    ]);
  });

  test('a copy that failed leaves nothing to take off', async () => {
    const client = fakeClient(annotatedRaw());
    assert.equal(await copyTextOnly(client, docThatCopies(null), 'x'), null);
    assert.deepEqual(
      client.log.map(([k]) => k),
      ['begin', 'end'],
    );
  });

  // The copy still has the graphs a blind second annotator must not see:
  // it is deleted, and the failure is the copy's, so a retry starts clean.
  test('a copy whose graphs could not be taken off is deleted, and the copy fails', async () => {
    const failure = new Error('HTTP 500');
    const client = fakeClient(annotatedRaw(), { batchFails: failure });
    await assert.rejects(copyTextOnly(client, docThatCopies({ id: 'd9' }), 'x'), (err) => {
      assert.equal(err, failure);
      assert.ok(!(err instanceof CopyKeptGraphs));
      return true;
    });
    assert.deepEqual(
      client.log.map((entry) => (entry[0] === 'delete' ? entry : entry[0])),
      ['begin', 'get', 'batch', 'end', ['delete', 'd9', 'Delete "x"']],
    );
  });

  test('a copy that could not be deleted either says so and names the copy', async () => {
    const client = fakeClient(annotatedRaw(), {
      batchFails: new Error('HTTP 500'),
      deleteFails: new Error('HTTP 503'),
    });
    await assert.rejects(copyTextOnly(client, docThatCopies({ id: 'd9' }), 'x'), (err) => {
      assert.ok(err instanceof CopyKeptGraphs);
      assert.deepEqual(err.created, { id: 'd9', name: 'x' });
      assert.equal(err.cause.message, 'HTTP 500');
      return true;
    });
    assert.ok(client.log.some(([k]) => k === 'delete'));
  });

  test('a copy that failed is never deleted', async () => {
    const client = fakeClient(annotatedRaw());
    const failing = { name: 'lunch', copyTo: async () => Promise.reject(new Error('HTTP 500')) };
    await assert.rejects(copyTextOnly(client, failing, 'x'), /HTTP 500/);
    assert.ok(!client.log.some(([k]) => k === 'delete'));
  });

  test('taking the graphs off a document with none sends nothing', async () => {
    const empty = applyPlan(annotatedRaw(), textOnlyPlan(annotatedRaw()));
    const client = fakeClient(empty);
    await leaveOutGraphs(client, 'd9');
    assert.deepEqual(client.log, [['get', 'd9', true]]);
  });
});
