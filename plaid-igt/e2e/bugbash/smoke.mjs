// Foundation smoke test: drives the real IgtDocument mutations against live
// plaid-core through a throwaway document, runs invariants after each op, and
// exercises media upload. Proves the harness before we fan out fuzz agents.
//
//   node e2e/bugbash/smoke.mjs

import { makeClient, getFixtureProjectId, freshDoc, reloadFresh, cleanupDoc, tinyWav } from './harness.mjs';
import { runAllInvariants, optimisticMatchesServer } from './invariants.mjs';

const log = (...a) => console.log(...a);

async function step(label, doc, fn) {
  const ok = await fn();
  const err = doc.error;
  const fresh = await reloadFresh(doc.client, doc.projectId, doc.id);
  const { violations } = runAllInvariants(fresh);
  const status = ok ? 'ok' : 'FALSE-FAIL';
  log(`\n[${label}] ret=${ok} ${err ? `error="${err}"` : ''} -> ${status}`);
  log(`   body="${fresh.body}"`);
  log(`   alignments=${(fresh.layerInfo.alignmentTokenLayer?.tokens || []).length} sentences=${(fresh.layerInfo.sentenceTokenLayer?.tokens || []).length}`);
  if (violations.length) {
    log(`   *** ${violations.length} INVARIANT VIOLATION(S):`);
    for (const v of violations) log(`     - [${v.name}] ${v.msg}`);
  }
  return { ok, err, fresh, violations };
}

async function main() {
  const client = makeClient();
  const projectId = await getFixtureProjectId(client);
  log(`fixture project: ${projectId}`);

  const { doc, documentId } = await freshDoc(client, projectId, { body: 'the quick brown fox' });
  log(`throwaway doc: ${documentId}`);
  log(`initial body="${doc.body}"`);
  log(`initial invariants:`, runAllInvariants(doc).violations);

  try {
    await step('createAlignment t=[0,1] "the"', doc, () => doc.createAlignment({ text: 'the', timeBegin: 0, timeEnd: 1 }));
    await step('createAlignment t=[2,3] "brown"', doc, () => doc.createAlignment({ text: 'brown', timeBegin: 2, timeEnd: 3 }));
    await step('createAlignment t=[1,2] "quick" (between)', doc, () => doc.createAlignment({ text: 'quick', timeBegin: 1, timeEnd: 2 }));

    // alignBaseline: align existing text WITHOUT inserting (optimistic, no reload).
    const r = await step('alignBaseline t=[3,4] "fox"', doc, () => doc.alignBaseline({ text: 'fox', timeBegin: 3, timeEnd: 4 }));
    const divergence = optimisticMatchesServer(doc, r.fresh);
    log(`   optimistic-vs-server: ${divergence.length ? 'DIVERGED' : 'match'}`);
    for (const d of divergence) log(`     ! ${d}`);

    await step('editAlignment first -> "THE" t=[0,1]', doc, () => {
      const id = doc.layerInfo.alignmentTokenLayer.tokens.sort((a, b) => a.begin - b.begin)[0].id;
      return doc.editAlignment(id, { text: 'THE', timeBegin: 0, timeEnd: 1 });
    });

    await step('deleteAlignment last', doc, () => {
      const toks = doc.layerInfo.alignmentTokenLayer.tokens.sort((a, b) => a.begin - b.begin);
      return doc.deleteAlignment(toks[toks.length - 1].id);
    });

    await step('saveBaselineText "hello world again"', doc, () => doc.saveBaselineText('hello world again'));

    // Media upload (Tika-validated). If this fails the harness still works for
    // non-media flows; we just report it.
    const up = await step('uploadMedia tinyWav', doc, () => doc.uploadMedia(tinyWav()));
    log(`   mediaUrl=${up.fresh.document.mediaUrl || '(none)'}`);
    if (up.ok) await step('deleteMedia', doc, () => doc.deleteMedia());

    await step('clearAlignments', doc, () => doc.clearAlignments());
  } finally {
    await cleanupDoc(client, documentId);
    log(`\ncleaned up ${documentId}`);
  }
}

main().then(() => { log('\nSMOKE DONE'); process.exit(0); }).catch((e) => { console.error('SMOKE ERROR', e); process.exit(1); });
