// The Validation tab's read of a project: which documents it opens, how many
// at once, and in what order the rows come back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { rawFromPlan } from './rawFromPlan.js';
import {
  validateProject,
  documentsWithNodes,
  documentsWithWords,
} from '../src/domain/validationQueries.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'umr',
  'english_umr-0001.umr',
);

// Parsed once: every fake read hands back the same document.
const RAW = rawFromPlan(planImport(parseUmrFile(fs.readFileSync(FIXTURE, 'utf8')).sentences, []));

// The same document with its graph taken out: the words are there, nothing
// is annotated over them. That is most of a corpus being worked through, and
// what the validator has to say about one is a warning per word.
const UNANNOTATED = (() => {
  const raw = structuredClone(RAW);
  const nodeLayer = raw.textLayers[0].tokenLayers[2];
  nodeLayer.tokens = [];
  const concepts = nodeLayer.spanLayers[0];
  concepts.spans = [];
  for (const rl of concepts.relationLayers) rl.relations = [];
  return raw;
})();

const CONCEPT_LAYER = 'conceptL';
const WORD_LAYER = 'wordL';
const LAYERS = { conceptLayerId: CONCEPT_LAYER, wordLayerId: WORD_LAYER };

const docNames = (n) => Array.from({ length: n }, (_, i) => `doc ${i}`);

// A project of `count` documents, of which `annotated` (a set of names) hold
// a graph and `worded` (all of them, unless said) hold words. Each query
// answers from its own set; a read of anything else is what the test is
// watching for.
function fakeClient(count, annotated, worded = null) {
  const docs = Array.from({ length: count }, (_, i) => ({ id: `d${i}`, name: `doc ${i}` }));
  const reads = [];
  let live = 0;
  let mostLive = 0;
  const queries = [];
  const withWords = worded ?? new Set(docs.map((d) => d.name));
  return {
    docs,
    reads,
    queries,
    get mostLive() {
      return mostLive;
    },
    client: {
      projects: { listDocuments: async () => docs },
      query: async (q) => {
        queries.push(q);
        const asked = q.where[0][0] === 'span' ? annotated : withWords;
        return { results: docs.filter((d) => asked.has(d.name)).map((d) => [d.id, 1]) };
      },
      documents: {
        get: async (id) => {
          reads.push(id);
          live += 1;
          mostLive = Math.max(mostLive, live);
          // A turn of the event loop per read, so overlapping reads overlap.
          await new Promise((resolve) => setTimeout(resolve, 1));
          live -= 1;
          return structuredClone(
            annotated.has(docs.find((d) => d.id === id).name) ? RAW : UNANNOTATED,
          );
        },
      },
    },
  };
}

test('the query names the documents that hold a node, scoped to the project', () => {
  const q = documentsWithNodes('p1', CONCEPT_LAYER);
  assert.deepEqual(q.scope, { projectIds: ['p1'] });
  assert.deepEqual(q.where, [['span', '?s', { layer: CONCEPT_LAYER, doc: { var: '?d' } }]]);
  assert.deepEqual(q.return.group, ['?d']);
});

test('the query names the documents that hold a word, scoped to the project', () => {
  const q = documentsWithWords('p1', WORD_LAYER);
  assert.deepEqual(q.scope, { projectIds: ['p1'] });
  assert.deepEqual(q.where, [['token', '?t', { layer: WORD_LAYER, doc: { var: '?d' } }]]);
  assert.deepEqual(q.return.group, ['?d']);
});

test('a document with neither a graph nor a word is never read', async () => {
  const f = fakeClient(10, new Set(['doc 2', 'doc 7']), new Set(['doc 2', 'doc 5', 'doc 7']));
  const rows = await validateProject(f.client, 'p1', LAYERS);
  assert.deepEqual(f.reads, ['d2', 'd5', 'd7']);
  assert.equal(f.queries.length, 2);
  assert.deepEqual([...new Set(rows.map((r) => r.documentName))], ['doc 2', 'doc 5', 'doc 7']);
});

// The report is how a corpus manager finds the documents nobody has started:
// the validator's own answer for one is a warning per word carrying no node.
test('a document with words and no graph is reported, word by word', async () => {
  const f = fakeClient(2, new Set(['doc 0']));
  const rows = await validateProject(f.client, 'p1', LAYERS);
  assert.deepEqual(f.reads, ['d0', 'd1']);
  const unannotated = rows.filter((r) => r.documentName === 'doc 1');
  assert.ok(unannotated.length > 0, 'the unannotated document is in the report');
  assert.deepEqual([...new Set(unannotated.map((r) => r.code))], ['unaligned-token']);
  assert.ok(unannotated.every((r) => r.level === 'warning'));
  assert.match(unannotated[0].message, /is not aligned to any node/);
});

test('the reads run a few at a time, not one after another and not all at once', async () => {
  const f = fakeClient(20, new Set(docNames(20)));
  await validateProject(f.client, 'p1', LAYERS);
  assert.equal(f.reads.length, 20);
  assert.ok(f.mostLive > 1, 'more than one read is in flight');
  assert.ok(f.mostLive <= 4, `at most four in flight, saw ${f.mostLive}`);
});

test('the rows stay in document order however the reads finish', async () => {
  const f = fakeClient(8, new Set(docNames(8)));
  const rows = await validateProject(f.client, 'p1', LAYERS);
  const order = [...new Set(rows.map((r) => r.documentId))];
  assert.deepEqual(
    order,
    f.docs.map((d) => d.id),
  );
});

test('progress counts the documents that are read, not the whole corpus', async () => {
  const worth = new Set(['doc 1', 'doc 4', 'doc 9']);
  const f = fakeClient(10, worth, worth);
  const seen = [];
  await validateProject(f.client, 'p1', {
    ...LAYERS,
    onProgress: (done, total) => seen.push([done, total]),
  });
  assert.deepEqual(seen.at(-1), [3, 3]);
  assert.equal(Math.max(...seen.map(([done]) => done)), 3);
});

// A project whose layers are not resolved yet: every document is read, as
// before, rather than nothing being checked.
test('with no layers to ask about, every document is read', async () => {
  const f = fakeClient(3, new Set());
  await validateProject(f.client, 'p1', {});
  assert.deepEqual(f.reads, ['d0', 'd1', 'd2']);
  assert.equal(f.queries.length, 0);
});
