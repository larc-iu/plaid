// My own minimal confirmation of the headline finding: createAlignment's
// overlap pre-check compares the NEW token's POST-insert offsets against
// EXISTING tokens' PRE-insert offsets, so it falsely rejects a valid insert
// between two positionally-adjacent alignments. Proven valid by replaying the
// exact batch the op would submit (server accepts; invariants clean).
import { makeClient, getFixtureProjectId, freshDoc, reloadFresh, cleanupDoc, cpLength } from './harness.mjs';
import { runAllInvariants } from './invariants.mjs';

const client = makeClient();
const projectId = await getFixtureProjectId(client);

// --- Case 1: createAlignment middle-insert false rejection ---
{
  const { doc, documentId } = await freshDoc(client, projectId, { body: 'the quick brown fox' });
  try {
    await doc.createAlignment({ text: 'the', timeBegin: 0, timeEnd: 1 });
    await doc.createAlignment({ text: 'brown', timeBegin: 2, timeEnd: 3 });
    const ok = await doc.createAlignment({ text: 'quick', timeBegin: 1, timeEnd: 2 });
    console.log(`CASE1 createAlignment(quick,t=1) -> ${ok}  error="${doc.error}"`);
    console.log(`  (placing quick@t1 between the@t0 and brown@t2 is clearly valid)`);
  } finally { await cleanupDoc(client, documentId); }
}

// --- Case 1b: prove validity by replaying the EXACT batch the op would submit ---
{
  const { doc, documentId } = await freshDoc(client, projectId, { body: 'the quick brown fox' });
  try {
    await doc.createAlignment({ text: 'the', timeBegin: 0, timeEnd: 1 });
    await doc.createAlignment({ text: 'brown', timeBegin: 2, timeEnd: 3 });
    // Manually replay createAlignment's batch for "quick" between the two:
    const info = doc.layerInfo;
    const textId = info.primaryTextLayer.text.id;
    const alignLayer = info.alignmentTokenLayer.id;
    // body is now 'the quick brown fox the brown'; the@[20,23) brown@[24,29)
    // createAlignment would insert ' quick' at cp 23 then token [24,29).
    client.beginBatch();
    client.texts.update(textId, [{ type: 'insert', index: 23, value: ' quick' }]);
    client.tokens.create(alignLayer, textId, 24, 29, undefined, { timeBegin: 1, timeEnd: 2 });
    await client.submitBatch();
    const fresh = await reloadFresh(client, projectId, documentId);
    const aligns = fresh.layerInfo.alignmentTokenLayer.tokens.slice().sort((a, b) => a.begin - b.begin);
    console.log(`CASE1b replayed batch -> server ACCEPTED. body="${fresh.body}"`);
    console.log(`  alignments: ${aligns.map(t => `[${t.begin},${t.end})@t${t.metadata.timeBegin}`).join(' ')}`);
    console.log(`  invariants: ${JSON.stringify(runAllInvariants(fresh).violations)}`);
  } finally { await cleanupDoc(client, documentId); }
}

// --- Case 2: editAlignment grow-past-next-token false rejection ---
{
  const { doc, documentId } = await freshDoc(client, projectId, { body: 'the quick brown fox' });
  try {
    await doc.createAlignment({ text: 'the', timeBegin: 0, timeEnd: 1 });
    await doc.createAlignment({ text: 'fox', timeBegin: 1, timeEnd: 2 });
    const id = doc.layerInfo.alignmentTokenLayer.tokens.slice().sort((a, b) => a.begin - b.begin)[0].id;
    const ok = await doc.editAlignment(id, { text: 'BROWNISHWORD', timeBegin: 0, timeEnd: 1 });
    console.log(`CASE2 editAlignment(grow first token's text) -> ${ok}  error="${doc.error}"`);
  } finally { await cleanupDoc(client, documentId); }
}

console.log('\nREPRO DONE');
process.exit(0);
