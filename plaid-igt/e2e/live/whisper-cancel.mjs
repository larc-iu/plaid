// Live check that Cancel bites on the real Whisper transcriber, and that a
// stop lands BEFORE anything is written.
//
//   node e2e/live/whisper-cancel.mjs <documentId>
//
// Whisper's transcription is one blocking call into the model, so the stop
// takes effect when that call returns — at the checkpoint just before the
// write phase, which is wrapped in `critical()`. What this asserts is the
// property that matters: the request comes back stopped, and the document is
// untouched.
import { makeClient, getFixtureProjectId } from '../bugbash/harness.mjs';

const client = makeClient();
const projectId = await getFixtureProjectId(client);
const documentId = process.argv[2];

const roleOf = (l) => l?.config?.plaid?.role;
const shape = async () => {
  const raw = await client.documents.get(documentId, true);
  const text = raw.textLayers[0];
  const counts = {};
  for (const tl of text.tokenLayers) counts[roleOf(tl)] = (tl.tokens || []).length;
  return { body: (text.text?.body || '').length, ...counts };
};

const before = await shape();
const raw = await client.documents.get(documentId, true);
const text = raw.textLayers[0];
const data = {
  model_size: 'base',
  documentId,
  textLayerId: text.id,
  alignmentTokenLayerId: text.tokenLayers.find((l) => roleOf(l) === 'time-alignment').id,
  sentenceTokenLayerId: text.tokenLayers.find((l) => roleOf(l) === 'sentence').id,
};

console.log('before:', JSON.stringify(before));
const started = Date.now();
const result = await client.messages.requestService(
  projectId,
  'asr:whisper-asr',
  data,
  10 * 60 * 1000,
  (p) => console.log(`  @${Date.now() - started}ms`, p.percent + '%', p.message),
  undefined,
  {
    onAccepted: (id) => {
      console.log('request', id, '— asking it to stop in 3s');
      setTimeout(() => client.messages.cancelServiceRequest(projectId, id), 3000);
    },
  },
);

const after = await shape();
console.log('result:', JSON.stringify(result));
console.log('after: ', JSON.stringify(after));

const untouched = JSON.stringify(before) === JSON.stringify(after);
const ok = result?.stopped === true && untouched;
console.log(
  ok
    ? 'PASS: stopped, and the document was not written to'
    : `FAIL: stopped=${result?.stopped} untouched=${untouched}`,
);
process.exit(ok ? 0 : 1);
