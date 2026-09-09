// Live check that a BUILT-IN Auto-analyze step stops when it is asked to.
//
//   node e2e/builtin-stop-live.mjs [projectId] [documentId]
//
// Two of Auto-analyze's four steps have no service behind them, and the copy
// step is the slowest thing in the run: precedent means fetching up to
// MAX_SOURCE_DOCS other documents ONE AT A TIME. Until the checkpoints went in
// it could not be interrupted at all: the dialog hid its Stop because no
// request was in flight, and the banner showed a Stop that did nothing.
//
// This drives the real phase against real data with a stop that fires after
// the first source document is read. Nothing is written: every checkpoint sits
// BEFORE a write, so a stopped run cannot leave a half-applied pass behind.
import { makeClient, getFixtureProjectId } from './bugbash/harness.mjs';
import { IgtDocument } from '../src/domain/IgtDocument.js';
import { runBuiltinAnalysis } from '../src/domain/autoPass.js';

const client = makeClient();
const projectId = process.argv[2] || (await getFixtureProjectId(client));
let documentId = process.argv[3];
if (!documentId) {
  const listed = await client.projects.listDocuments(projectId);
  // An array here, an {entries} page elsewhere, and `[].entries` is a METHOD,
  // so `listed.entries || listed` would hand back Array.prototype.entries.
  const docs = Array.isArray(listed) ? listed : (listed?.entries ?? []);
  documentId = docs[0]?.id;
  if (!documentId) throw new Error('Pass a documentId: none found on the project');
  console.log(`${docs.length} document(s) on the project; using ${documentId}`);
}

const doc = await IgtDocument.load(client, projectId, documentId);
const copyAll = { segmentation: true, links: true, fields: true };

// Count what the phase actually reads, and refuse every write.
let reads = 0;
const realGet = client.documents.get.bind(client.documents);
client.documents.get = async (...args) => {
  if (args[0] !== documentId) reads += 1;
  return realGet(...args);
};
let wrote = false;
doc.bulkApplyAnalyses = async () => {
  wrote = true;
  throw new Error('a stopped run must not write');
};

const line = (m) => console.log('  ' + m);

// 1. Stop after the first source document is read.
let stop = false;
const res = await runBuiltinAnalysis(doc, {
  copy: true,
  link: false,
  copyContents: copyAll,
  onProgress: (p) => line(`${p.percent == null ? '--' : Math.round(p.percent) + '%'} ${p.message}`),
  shouldStop: () => stop || (reads >= 1 && (stop = true)),
});

console.log(`\nread ${reads} source document(s) before stopping`);
console.log('result:', JSON.stringify(res));

const failures = [];
if (res.stopped !== true) failures.push('the phase did not report itself stopped');
if (res.ok !== true) failures.push('a stop was reported as a failure');
if (wrote) failures.push('it wrote after being asked to stop');
if (reads > 2) failures.push(`it read ${reads} documents after being asked to stop at 1`);

for (const f of failures) console.log('FAIL:', f);
console.log(failures.length ? 'FAILED' : 'PASS: stopped at the next checkpoint, before any write');
process.exit(failures.length ? 1 : 0);
