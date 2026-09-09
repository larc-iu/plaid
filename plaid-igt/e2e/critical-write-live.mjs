// Live check that a service's `critical()` write phase is never left half done.
//
//   node e2e/critical-write-live.mjs <serviceId> [runs]
//
// All five bundled services wrap their write phase in
// `with response_helper.critical(), self.client.operation(...)`, so a stop
// asked for while the writes are under way is suppressed until they finish.
// Only Whisper had ever run that path for real (e2e/whisper-cancel-live.mjs).
// This does it for the others.
//
// The invariant is self-calibrating: one uncancelled run establishes what a
// FINISHED document looks like, and then every cancelled run must land on
// either the pristine shape (stopped at the checkpoint before the writes) or
// exactly that finished shape. Anything in between is a half-written document,
// which is the thing critical() exists to prevent.
import { makeClient, getFixtureProjectId, freshDoc, cleanupDoc } from './bugbash/harness.mjs';

const client = makeClient();
const projectId = await getFixtureProjectId(client);
const serviceId = process.argv[2] || 'tok:nltk-punkt-tokenizer';
const RUNS = Number(process.argv[3] || 6);

// Long enough that the write phase is a window worth aiming at, not an instant.
const BODY = Array.from(
  { length: 40 },
  (_, i) => `This is sentence number ${i + 1}, which has a clause in it. And a second one!`,
).join(' ');

const roleOf = (l) => l?.config?.plaid?.role;

/** Same reported fields as the control run (ids and counts may differ). */
const sameKeys = (a, b) =>
  a && b && JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());

/** The countable shape of a document: body length and tokens per layer. */
async function shape(documentId) {
  const raw = await client.documents.get(documentId, true);
  const text = raw.textLayers.find((l) => l.config?.plaid?.primary) || raw.textLayers[0];
  const counts = {};
  for (const tl of text.tokenLayers || []) counts[roleOf(tl)] = (tl.tokens || []).length;
  return JSON.stringify({ body: (text.text?.body || '').length, ...counts });
}

async function makeDoc(name) {
  const { documentId } = await freshDoc(client, projectId, {
    name,
    body: BODY,
    seedWords: false,
    seedMorphemes: false,
  });
  const raw = await client.documents.get(documentId, true);
  const text = raw.textLayers.find((l) => l.config?.plaid?.primary) || raw.textLayers[0];
  return {
    documentId,
    data: {
      documentId,
      textLayerId: text.id,
      primaryTokenLayerId: text.tokenLayers.find((l) => roleOf(l) === 'word').id,
      sentenceLayerId: text.tokenLayers.find((l) => roleOf(l) === 'sentence').id,
    },
  };
}

const run = async (data, cancelAfterMs) =>
  client.messages.requestService(projectId, serviceId, data, 5 * 60 * 1000, undefined, undefined, {
    onAccepted: (id) => {
      if (cancelAfterMs != null) {
        setTimeout(
          () => client.messages.cancelServiceRequest(projectId, id).catch(() => {}),
          cancelAfterMs,
        );
      }
    },
  });

// 1. What a finished document looks like, with nothing interrupting it.
const control = await makeDoc(`critical-control ${Date.now()}`);
const pristine = await shape(control.documentId);
const controlResult = await run(control.data, null);
const finished = await shape(control.documentId);
await cleanupDoc(client, control.documentId);
console.log('pristine:', pristine);
console.log('finished:', finished);
if (pristine === finished) {
  console.log('FAIL: the uncancelled run wrote nothing, so there is no invariant to test');
  process.exit(1);
}
console.log('control result:', JSON.stringify(controlResult), '\n');

// 2. Cancel at a spread of delays and insist on one of the two valid shapes.
const failures = [];
const seen = { pristine: 0, finished: 0 };
for (let i = 0; i < RUNS; i++) {
  const delay = 60 + i * 90; // walk the cancel across the run
  const doc = await makeDoc(`critical-cancel-${i} ${Date.now()}`);
  let result;
  try {
    result = await run(doc.data, delay);
  } catch (err) {
    failures.push(`run ${i} (cancel @${delay}ms) raised: ${err.message}`);
    await cleanupDoc(client, doc.documentId);
    continue;
  }
  const after = await shape(doc.documentId);
  const where = after === pristine ? 'pristine' : after === finished ? 'finished' : 'HALF-WRITTEN';
  const stopped = result?.stopped === true;
  if (where === 'HALF-WRITTEN') {
    failures.push(`run ${i} (cancel @${delay}ms) left ${after}, neither pristine nor finished`);
  } else {
    seen[where] += 1;
  }
  // Luke's ruling: a stop that arrives once everything is already done is
  // silently ignored. A run that wrote the whole document finished, whatever
  // was asked of it afterwards, so it must say so and must still carry its
  // counts. Reporting it stopped both understates what happened and ends an
  // Auto-analyze run whose step actually succeeded.
  if (where === 'finished' && stopped) {
    failures.push(`run ${i} (cancel @${delay}ms) wrote the whole document but reported stopped`);
  }
  if (where === 'finished' && !sameKeys(result, controlResult)) {
    failures.push(
      `run ${i} (cancel @${delay}ms) finished but lost its result: ${JSON.stringify(result)}`,
    );
  }
  console.log(
    `  cancel @${String(delay).padStart(4)}ms -> stopped=${stopped} ${where}` +
      (where === 'finished' ? ` result=${JSON.stringify(result)}` : ''),
  );
  await cleanupDoc(client, doc.documentId);
}

console.log(`\n${seen.pristine} stopped before the writes, ${seen.finished} wrote in full`);
if (!seen.finished) {
  console.log(
    'NOTE: every cancel landed before the write phase, so critical() itself was never entered.',
  );
  console.log('      Lower the delays, or use a bigger document, to reach into the writes.');
}
for (const f of failures) console.log('FAIL:', f);
console.log(failures.length ? 'FAILED' : 'PASS: never half written');
process.exit(failures.length ? 1 : 0);
