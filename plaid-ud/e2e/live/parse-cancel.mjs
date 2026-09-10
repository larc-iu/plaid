// Live check that stopping the Stanza parser never leaves a half-parsed
// document, and that a stop it reports is a stop that wrote nothing.
//
//   node e2e/live/parse-cancel.mjs [blind runs]
//
// Needs the dev core on :8085 and the parser running against it:
//   python services/ud_parse_stanza.py --all --url http://localhost:8085
//
// The parse phase reports progress (per group of sentences when re-parsing an
// already tokenized document, once either side of the pipeline call when
// parsing from scratch) and every one of those reports is a cancellation
// checkpoint. The write phase reports too, but from inside `critical()`, where
// a checkpoint does not raise. So a stop lands in exactly one of two places,
// and this asserts you never see a third:
//
//   before the writes  -> the document is untouched and the result says stopped
//   during the writes  -> the writes finish, and the result is a normal one
//
// Blind timing would leave which of the two got exercised up to how fast the
// machine is (on a GPU the parse is a fraction of the run, and eight blind
// stops all landed in the writes), so the two aimed runs stop the parser at a
// named point in its own progress instead. The blind runs then walk a stop
// across the whole thing looking for a third landing.
//
// The finished shape is self-calibrating: one uncancelled control run defines
// it, so this keeps working as the parser changes.
import PlaidClient from '@larc-iu/plaid-client';
import { readToken } from '../fixtures.js';
import { getFixture } from '../fixture.js';

const BASE_URL = 'http://localhost:8085';
const SERVICE_ID = 'stanza-parser';
const BLIND_RUNS = Number(process.argv[2] || 6);

// The parser's phase budget (see ParseProgress in services/ud_parse_stanza.py).
const PARSE_STARTS_AT = 20;
// The parse phase ENDS at 60 (its last report is "Parsed N sentences"), so the
// first percentage that is unambiguously inside the write phase is above it.
const WRITES_START_AT = 61;

const { token } = readToken();
const client = new PlaidClient(BASE_URL, token);
const { projectId } = await getFixture();

// Long enough that the parse and the write phase are each a window worth
// aiming at, rather than an instant.
const BODY = Array.from(
  { length: 60 },
  (_, i) => `This is sentence number ${i + 1}, which carries a clause of its own. `,
).join('');

const roleOf = (l) => l?.config?.plaid?.role;

/**
 * The countable shape of a document: body length, then every token, span and
 * relation layer under it by name. Counting only tokens would miss the shape
 * this probe most needs to see, since the parser writes tokens, then spans,
 * then relations in three separate steps: a stop between them leaves a
 * document with all its tokens and none of its annotations, which by a
 * token-only count is indistinguishable from a finished one.
 */
async function shape(documentId) {
  const raw = await client.documents.get(documentId, true);
  const text = raw.textLayers[0];
  const counts = {};
  for (const tl of text.tokenLayers || []) {
    counts[roleOf(tl) || tl.name] = (tl.tokens || []).length;
    for (const sl of tl.spanLayers || []) {
      counts[sl.name] = (sl.spans || []).length;
      for (const rl of sl.relationLayers || []) counts[rl.name] = (rl.relations || []).length;
    }
  }
  return JSON.stringify({ body: (text.text?.body || '').length, ...counts });
}

async function makeDoc(name) {
  const project = await client.projects.get(projectId);
  const textLayer = project.textLayers[0];
  const doc = await client.documents.create(projectId, name);
  await client.texts.create(textLayer.id, doc.id, BODY);
  return doc.id;
}

/**
 * Run a parse, asking it to stop either after `afterMs` or the first time it
 * reports a percentage at or past `atPercent`. Pass neither to let it finish.
 */
function run(documentId, { afterMs = null, atPercent = null } = {}) {
  let asked = false;
  const stop = (id) => {
    if (asked) return;
    asked = true;
    client.messages.cancelServiceRequest(projectId, id).catch(() => {});
  };
  let requestId = null;
  return client.messages.requestService(
    projectId,
    SERVICE_ID,
    { documentId, language: 'en', overwrite: true },
    5 * 60 * 1000,
    (p) => {
      if (
        atPercent != null &&
        requestId &&
        typeof p?.percent === 'number' &&
        p.percent >= atPercent
      )
        stop(requestId);
    },
    undefined,
    {
      onAccepted: (id) => {
        requestId = id;
        if (afterMs != null) setTimeout(() => stop(id), afterMs);
      },
    },
  );
}

// 1. What a finished parse looks like, with nothing interrupting it.
const controlId = await makeDoc(`parse-cancel-control ${Date.now()}`);
const pristine = await shape(controlId);
const started = Date.now();
const controlResult = await run(controlId);
const controlMs = Date.now() - started;
const finished = await shape(controlId);
await client.documents.delete(controlId);

console.log('pristine:', pristine);
console.log('finished:', finished, `(${controlMs}ms)`);
if (pristine === finished) {
  console.log('FAIL: the uncancelled run wrote nothing, so there is no invariant to test');
  process.exit(1);
}
console.log('control result:', JSON.stringify(controlResult), '\n');

const failures = [];
const seen = { pristine: 0, finished: 0 };

/** Run once, classify where it landed, and check the result matches. */
async function check(label, opts) {
  const documentId = await makeDoc(`parse-cancel ${label} ${Date.now()}`);
  let result;
  try {
    result = await run(documentId, opts);
  } catch (err) {
    failures.push(`${label} raised: ${err.message}`);
    await client.documents.delete(documentId);
    return null;
  }
  const after = await shape(documentId);
  const where = after === pristine ? 'pristine' : after === finished ? 'finished' : 'HALF-WRITTEN';
  const stopped = result?.stopped === true;
  if (where === 'HALF-WRITTEN') {
    failures.push(`${label} left ${after}, neither pristine nor finished`);
  } else {
    seen[where] += 1;
  }
  // A run that wrote the whole document finished, whatever was asked of it
  // afterwards, and must say so and still carry its counts. Reporting it
  // stopped understates what happened, and a caller acts on that word.
  if (where === 'finished' && stopped) {
    failures.push(`${label} wrote the whole document but reported stopped`);
  }
  if (where === 'finished' && result?.parsedSentences == null) {
    failures.push(`${label} finished but lost its counts`);
  }
  // The other direction: an untouched document must not be reported as a parse.
  if (where === 'pristine' && !stopped) {
    failures.push(`${label} wrote nothing but did not report stopped`);
  }
  console.log(
    `  ${label.padEnd(26)} -> stopped=${String(stopped).padEnd(5)} ${where}` +
      (where === 'finished' ? ` result=${JSON.stringify(result)}` : ''),
  );
  await client.documents.delete(documentId);
  return where;
}

// 2. The two landings, each aimed at by name.
const inParse = await check('stop once parsing', { atPercent: PARSE_STARTS_AT });
if (inParse && inParse !== 'pristine') {
  failures.push('a stop during the parse phase wrote to the document');
}
const inWrites = await check('stop once writing', { atPercent: WRITES_START_AT });
if (inWrites && inWrites !== 'finished') {
  failures.push('a stop during the write phase left the writes unfinished');
}

// 3. The already-tokenized path. Parsing from scratch is one blocking call
// into Stanza, so it can only be stopped at the boundary either side of it; a
// re-parse hands the pipeline a group of sentences at a time and reports
// between groups, which is the only place this parser can be stopped part-way
// THROUGH its parsing. Check that a re-parse reproduces the same document, and
// that stopping one leaves it exactly as it was.
{
  const documentId = await makeDoc(`parse-cancel repeat ${Date.now()}`);
  await run(documentId); // from scratch
  const afterFirst = await shape(documentId);
  const again = await run(documentId); // already tokenized: the preserve path
  const afterSecond = await shape(documentId);
  if (again?.mode !== 'preserve') {
    failures.push(`a re-parse took the '${again?.mode}' path, not 'preserve'`);
  }
  if (afterSecond !== afterFirst) {
    failures.push(`a re-parse changed the document: ${afterFirst} -> ${afterSecond}`);
  }
  const stoppedResult = await run(documentId, { atPercent: PARSE_STARTS_AT });
  const afterStopped = await shape(documentId);
  const ok = stoppedResult?.stopped === true && afterStopped === afterSecond;
  if (!ok) {
    failures.push(
      `stopping a re-parse: stopped=${stoppedResult?.stopped}, ` +
        `document ${afterStopped === afterSecond ? 'unchanged' : 'CHANGED to ' + afterStopped}`,
    );
  }
  console.log(
    `  re-parse                   -> mode=${again?.mode} document unchanged=${afterSecond === afterFirst}`,
  );
  console.log(
    `  stop once re-parsing       -> stopped=${stoppedResult?.stopped === true} ` +
      `document unchanged=${afterStopped === afterSecond}`,
  );
  await client.documents.delete(documentId);
}

// 4. Blind stops walked across the run, hunting for a third landing.
for (let i = 0; i < BLIND_RUNS; i++) {
  const delay = Math.round((controlMs * (i + 1)) / (BLIND_RUNS + 1));
  await check(`stop @${String(delay).padStart(5)}ms`, { afterMs: delay });
}

console.log(`\n${seen.pristine} stopped before the writes, ${seen.finished} wrote in full`);
for (const f of failures) console.log('FAIL:', f);
console.log(failures.length ? 'FAILED' : 'PASS: never half parsed');
process.exit(failures.length ? 1 : 0);
