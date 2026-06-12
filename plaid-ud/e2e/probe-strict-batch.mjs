// Disposable probe: strict-mode OCC vs multi-op batches.
// 1. A strict client's batch with 2+ writes must NOT 409 against itself
//    (the head-repoint regression: delete-old + create-new in one batch).
// 2. OCC must still work: after ANOTHER client modifies the document, the
//    strict client's next write — single op or batch — must 409.
import { PlaidClient } from '../../plaid-client-js/src/index.js';

const API = 'http://localhost:8085';
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok ' : 'FAIL '}${label}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

const a = await PlaidClient.login(API, 'a@b.com', 'password'); // strict editor
const b = await PlaidClient.login(API, 'a@b.com', 'password'); // concurrent editor
const project = await a.projects.create(`probe-strict-batch-${Date.now()}`);
try {
  const tl = await a.textLayers.create(project.id, 'Text');
  const tokl = await a.tokenLayers.create(tl.id, 'Toks', 'any');
  const sl = await a.spanLayers.create(tokl.id, 'Lemma');
  const rl = await a.relationLayers.create(sl.id, 'Deps');
  const doc = await a.documents.create(project.id, 'd1');
  const text = await a.texts.create(tl.id, doc.id, 'aaa bbb ccc');
  const toks = await a.tokens.bulkCreate([
    { tokenLayerId: tokl.id, text: text.id, begin: 0, end: 3 },
    { tokenLayerId: tokl.id, text: text.id, begin: 4, end: 7 },
    { tokenLayerId: tokl.id, text: text.id, begin: 8, end: 11 },
  ]);
  const spans = await a.spans.bulkCreate(toks.ids.map((id) => ({ spanLayerId: sl.id, tokens: [id], value: 'x' })));
  const [s0, s1, s2] = spans.ids;
  const rel = await a.relations.create(rl.id, s0, s1, 'dep');

  // Enter strict mode and prime the version tracker with a fresh GET.
  a.enterStrictMode(doc.id);
  await a.documents.get(doc.id, true);

  // (1) Self-batch: delete the existing head + create the new one atomically.
  let selfBatchOk = true, selfBatchErr = '';
  try {
    a.beginBatch();
    a.relations.delete(rel.id);
    a.relations.create(rl.id, s2, s1, 'nsubj');
    await a.submitBatch();
  } catch (e) {
    selfBatchOk = false;
    selfBatchErr = `${e.status} ${e.message}`;
  }
  check('strict 2-op batch does not 409 against itself', selfBatchOk, selfBatchErr);

  // (2a) Concurrent modification, then a strict SINGLE write -> must 409.
  await b.relations.create(rl.id, s0, s2, 'obj'); // bumps the doc version
  let singleStale = null;
  try { await a.relations.create(rl.id, s1, s0, 'amod'); } catch (e) { singleStale = e.status; }
  check('stale single write still 409s', singleStale === 409, `got ${singleStale}`);

  // (2b) Refresh, concurrent modification again, then a strict BATCH -> must 409.
  await a.documents.get(doc.id, true);
  await b.relations.create(rl.id, s2, s0, 'xcomp');
  let batchStale = null;
  try {
    a.beginBatch();
    a.relations.create(rl.id, s1, s2, 'amod');
    a.relations.update?.(rel.id, 'noop'); // second op, may 404 — version check fires first
    await a.submitBatch();
  } catch (e) {
    batchStale = e.status;
  }
  check('stale batch still 409s on its first op', batchStale === 409, `got ${batchStale}`);
} finally {
  a.exitStrictMode();
  await a.projects.delete(project.id);
}
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
