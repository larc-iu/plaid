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
import { validateProject, documentsWithNodes } from '../src/domain/validationQueries.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'umr',
  'english_umr-0001.umr',
);

// Parsed once: every fake read hands back the same document.
const RAW = rawFromPlan(planImport(parseUmrFile(fs.readFileSync(FIXTURE, 'utf8')).sentences, []));

const CONCEPT_LAYER = 'conceptL';

const docNames = (n) => Array.from({ length: n }, (_, i) => `doc ${i}`);

// A project of `count` documents, of which `annotated` (a set of names) hold
// a graph. The query answers from that set; a read of anything else is what
// the test is watching for.
function fakeClient(count, annotated) {
  const docs = Array.from({ length: count }, (_, i) => ({ id: `d${i}`, name: `doc ${i}` }));
  const reads = [];
  let live = 0;
  let mostLive = 0;
  const queries = [];
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
        return { results: docs.filter((d) => annotated.has(d.name)).map((d) => [d.id, 1]) };
      },
      documents: {
        get: async (id) => {
          reads.push(id);
          live += 1;
          mostLive = Math.max(mostLive, live);
          // A turn of the event loop per read, so overlapping reads overlap.
          await new Promise((resolve) => setTimeout(resolve, 1));
          live -= 1;
          return structuredClone(RAW);
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

test('only the documents with a graph are read', async () => {
  const f = fakeClient(10, new Set(['doc 2', 'doc 7']));
  const rows = await validateProject(f.client, 'p1', CONCEPT_LAYER);
  assert.deepEqual(f.reads, ['d2', 'd7']);
  assert.equal(f.queries.length, 1);
  // Both documents' problems are there, each naming its own document.
  assert.deepEqual([...new Set(rows.map((r) => r.documentName))], ['doc 2', 'doc 7']);
  assert.ok(rows.length > 0);
});

test('the reads run a few at a time, not one after another and not all at once', async () => {
  const f = fakeClient(20, new Set(docNames(20)));
  await validateProject(f.client, 'p1', CONCEPT_LAYER);
  assert.equal(f.reads.length, 20);
  assert.ok(f.mostLive > 1, 'more than one read is in flight');
  assert.ok(f.mostLive <= 4, `at most four in flight, saw ${f.mostLive}`);
});

test('the rows stay in document order however the reads finish', async () => {
  const f = fakeClient(8, new Set(docNames(8)));
  const rows = await validateProject(f.client, 'p1', CONCEPT_LAYER);
  const order = [...new Set(rows.map((r) => r.documentId))];
  assert.deepEqual(
    order,
    f.docs.map((d) => d.id),
  );
});

test('progress counts the documents that are read, not the whole corpus', async () => {
  const f = fakeClient(10, new Set(['doc 1', 'doc 4', 'doc 9']));
  const seen = [];
  await validateProject(f.client, 'p1', CONCEPT_LAYER, {
    onProgress: (done, total) => seen.push([done, total]),
  });
  assert.deepEqual(seen.at(-1), [3, 3]);
  assert.equal(Math.max(...seen.map(([done]) => done)), 3);
});

// A project whose layers are not resolved yet: every document is read, as
// before, rather than nothing being checked.
test('with no concept layer to ask about, every document is read', async () => {
  const f = fakeClient(3, new Set());
  await validateProject(f.client, 'p1', null);
  assert.deepEqual(f.reads, ['d0', 'd1', 'd2']);
  assert.equal(f.queries.length, 0);
});
