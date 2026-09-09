// Live check that a request deadline is IDLE time, not a cap on the run. This
// is the JS half of services/idle_deadline_probe.py, which stands up the
// service:
//
//   python services/idle_deadline_probe.py --serve-only probe:idle-js &
//   node e2e/idle-deadline-live.mjs probe:idle-js
//
// A service that is reporting its progress is not hung, so every event it
// sends starts the clock again. As a deadline on the whole run, the
// five-minute default was shorter than a real transcription: a working run was
// reported as failed and its writes landed on a document the page had already
// handed back as editable.
//
// The second run checks the other side of the contract: when the client really
// does give up, the error carries `pending` because the request is still there
// to rejoin. That flag is what tells a caller to KEEP its run record.
import { makeClient, getFixtureProjectId } from './bugbash/harness.mjs';

const client = makeClient();
const projectId = await getFixtureProjectId(client);
const serviceId = process.argv[2] || 'probe:idle-js';
const DEADLINE_MS = 3000;
const failures = [];
const secs = (ms) => (ms / 1000).toFixed(1);

// 1. Talks for ten seconds under a three-second deadline. It never goes quiet,
//    so it must finish.
let started = Date.now();
try {
  const result = await client.messages.requestService(
    projectId,
    serviceId,
    { quiet: false },
    DEADLINE_MS,
    (p) => console.log(`  @${secs(Date.now() - started)}s ${p.message}`),
  );
  const took = Date.now() - started;
  console.log(`talkative: finished in ${secs(took)}s under a ${secs(DEADLINE_MS)}s deadline`);
  console.log('  result', JSON.stringify(result));
  if (took <= DEADLINE_MS) failures.push('the talkative run was shorter than the deadline');
} catch (err) {
  failures.push(`the talkative run was killed at ${secs(Date.now() - started)}s: ${err.message}`);
}

// 2. One silence longer than the deadline. It must give up, and say the
//    request is still out there rather than reporting the run as over.
started = Date.now();
try {
  await client.messages.requestService(projectId, serviceId, { quiet: true }, DEADLINE_MS);
  failures.push('the quiet run was not given up on');
} catch (err) {
  console.log(`quiet: gave up after ${secs(Date.now() - started)}s -> ${err.message}`);
  if (err.pending !== true) failures.push('the timeout did not say the request is still there');
  if (!/of silence/.test(err.message))
    failures.push(`the timeout did not name silence: ${err.message}`);
}

for (const f of failures) console.log('FAIL:', f);
console.log(
  failures.length
    ? 'FAILED'
    : 'PASS: a talking run outlives the deadline, a silent one does not, and giving up keeps the id',
);
process.exit(failures.length ? 1 : 0);
