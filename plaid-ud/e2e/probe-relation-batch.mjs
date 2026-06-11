// Disposable probe (e2e/ is a scratchpad): verify createRelation's new atomic
// replace pattern at the client level — a single relations.create inside a
// batch yields body.id, and delete+create in one batch leaves exactly one
// incoming relation on the target.
import { PlaidClient } from '../../plaid-client-js/src/index.js';

const client = await PlaidClient.login('http://localhost:8085', 'a@b.com', 'password');
const project = await client.projects.create(`probe-relbatch-${Date.now()}`);
try {
  const tl = await client.textLayers.create(project.id, 'Text');
  const tokl = await client.tokenLayers.create(tl.id, 'Toks', 'any');
  const sl = await client.spanLayers.create(tokl.id, 'Lemma');
  const rl = await client.relationLayers.create(sl.id, 'Deps');
  const doc = await client.documents.create(project.id, 'd1');
  const text = await client.texts.create(tl.id, doc.id, 'aaa bbb ccc');
  const toks = await client.tokens.bulkCreate([
    { tokenLayerId: tokl.id, text: text.id, begin: 0, end: 3 },
    { tokenLayerId: tokl.id, text: text.id, begin: 4, end: 7 },
    { tokenLayerId: tokl.id, text: text.id, begin: 8, end: 11 },
  ]);
  const spans = await client.spans.bulkCreate(toks.ids.map(id => ({ spanLayerId: sl.id, tokens: [id], value: 'x' })));
  const [s0, s1, s2] = spans.ids;

  // 1. Single relations.create inside a batch — result body must carry id.
  client.beginBatch();
  client.relations.create(rl.id, s0, s1, 'dep');
  const r1 = await client.submitBatch();
  const rel1 = r1[r1.length - 1]?.body?.id;
  console.log('create-in-batch last result body:', JSON.stringify(r1[r1.length - 1]?.body));
  if (!rel1) throw new Error('FAIL: no body.id from single create-in-batch');

  // 2. Atomic replace: delete old + create new in ONE batch (re-point head).
  client.beginBatch();
  client.relations.delete(rel1);
  client.relations.create(rl.id, s2, s1, 'nsubj');
  const r2 = await client.submitBatch();
  const rel2 = r2[r2.length - 1]?.body?.id;
  if (!rel2) throw new Error('FAIL: no body.id from replace batch');

  // 3. Final state: exactly one relation, s2 -> s1, 'nsubj'.
  const full = await client.documents.get(doc.id, true);
  const findRels = (o) => {
    if (!o || typeof o !== 'object') return [];
    if (Array.isArray(o)) return o.flatMap(findRels);
    let out = Array.isArray(o.relations) ? o.relations : [];
    for (const v of Object.values(o)) if (typeof v === 'object') out = out.concat(findRels(v));
    return out;
  };
  const rels = findRels(full);
  console.log('final relations:', JSON.stringify(rels));
  if (rels.length !== 1 || rels[0].source !== s2 || rels[0].target !== s1 || rels[0].value !== 'nsubj') {
    throw new Error('FAIL: unexpected final relation state');
  }
  console.log('PASS');
} finally {
  await client.projects.delete(project.id);
}
