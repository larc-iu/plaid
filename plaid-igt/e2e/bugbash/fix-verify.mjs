// Verifies the alignment.js fixes from the 2026-06-06 bug bash:
//  1. createAlignment middle-insert no longer falsely rejected
//  2. editAlignment grow-text no longer falsely rejected
//  3. negative-duration time ranges rejected (create/edit/updateBounds)
//  4. updateAlignmentBounds rejects a temporal/positional inversion
//  5. a valid updateAlignmentBounds still works
import { makeClient, getFixtureProjectId, freshDoc, reloadFresh, cleanupDoc } from './harness.mjs';
import { runAllInvariants } from './invariants.mjs';

const client = makeClient();
const projectId = await getFixtureProjectId(client);
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

// 1 + 2: the headline false-rejections are gone
{
  const { doc, documentId } = await freshDoc(client, projectId, { body: 'the quick brown fox' });
  try {
    await doc.createAlignment({ text: 'the', timeBegin: 0, timeEnd: 1 });
    await doc.createAlignment({ text: 'brown', timeBegin: 2, timeEnd: 3 });
    const ok = await doc.createAlignment({ text: 'quick', timeBegin: 1, timeEnd: 2 });
    const fresh = await reloadFresh(client, projectId, documentId);
    check('createAlignment middle-insert accepted', ok === true, `err="${doc.error}"`);
    check('  -> invariants clean', runAllInvariants(fresh).violations.length === 0, JSON.stringify(runAllInvariants(fresh).violations));
  } finally { await cleanupDoc(client, documentId); }
}
{
  const { doc, documentId } = await freshDoc(client, projectId, { body: 'the quick brown fox' });
  try {
    await doc.createAlignment({ text: 'the', timeBegin: 0, timeEnd: 1 });
    await doc.createAlignment({ text: 'fox', timeBegin: 1, timeEnd: 2 });
    const id = doc.layerInfo.alignmentTokenLayer.tokens.slice().sort((a, b) => a.begin - b.begin)[0].id;
    const ok = await doc.editAlignment(id, { text: 'BROWNISHWORD', timeBegin: 0, timeEnd: 1 });
    const fresh = await reloadFresh(client, projectId, documentId);
    check('editAlignment grow-text accepted', ok === true, `err="${doc.error}"`);
    check('  -> invariants clean', runAllInvariants(fresh).violations.length === 0);
  } finally { await cleanupDoc(client, documentId); }
}

// 3: negative duration rejected (no server write)
{
  const { doc, documentId } = await freshDoc(client, projectId, { body: 'alpha beta gamma' });
  try {
    const ok = await doc.createAlignment({ text: 'alpha', timeBegin: 9, timeEnd: 4 });
    check('createAlignment negative-duration rejected', ok === false && /Invalid time range/.test(doc.error || ''));
  } finally { await cleanupDoc(client, documentId); }
}

// 4 + 5: temporal-inversion guard on updateAlignmentBounds + valid edit still works
{
  const { doc, documentId } = await freshDoc(client, projectId, { body: 'the cat saw the dog' });
  try {
    await doc.createAlignment({ text: 'the', timeBegin: 0, timeEnd: 1 });   // earliest in text + time
    await doc.createAlignment({ text: 'cat', timeBegin: 2, timeEnd: 3 });   // later in text + time
    const first = doc.layerInfo.alignmentTokenLayer.tokens.slice().sort((a, b) => a.begin - b.begin)[0].id;
    const bad = await doc.updateAlignmentBounds(first, { timeBegin: 100, timeEnd: 101 }); // would invert vs 'cat'
    check('updateAlignmentBounds inversion rejected', bad === false && /temporal order/.test(doc.error || ''), `err="${doc.error}"`);
    const good = await doc.updateAlignmentBounds(first, { timeBegin: 0, timeEnd: 1.5 });  // in-order tweak
    const fresh = await reloadFresh(client, projectId, documentId);
    check('updateAlignmentBounds valid edit accepted', good === true);
    check('  -> invariants clean', runAllInvariants(fresh).violations.length === 0);
  } finally { await cleanupDoc(client, documentId); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
