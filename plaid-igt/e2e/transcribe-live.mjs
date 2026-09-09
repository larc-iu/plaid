// Live scratch probe: isolates a failing transcribe request. Is it the request
// shape this app now sends (a minted requestId plus an onProgress callback), or
// the service/server itself?
//
//   node e2e/transcribe-live.mjs <documentId>
import { makeClient, getFixtureProjectId } from './bugbash/harness.mjs';

const client = makeClient();
const projectId = await getFixtureProjectId(client);
const documentId = process.argv[2];
const raw = await client.documents.get(documentId, true);
const text = raw.textLayers[0];
const roleOf = (l) => l?.config?.plaid?.role;
const align = text.tokenLayers.find((l) => roleOf(l) === 'time-alignment');
const sent = text.tokenLayers.find((l) => roleOf(l) === 'sentence');

const data = {
  model_size: 'base',
  documentId,
  textLayerId: text.id,
  alignmentTokenLayerId: align.id,
  sentenceTokenLayerId: sent.id,
};

for (const [label, opts] of [
  ['plain (4 args, as before this change)', null],
  ['onProgress + minted requestId (as now)', { requestId: crypto.randomUUID() }],
]) {
  try {
    const r = opts
      ? await client.messages.requestService(
          projectId,
          'asr:whisper-asr',
          data,
          180000,
          (p) => console.log('   progress:', JSON.stringify(p)),
          undefined,
          opts,
        )
      : await client.messages.requestService(projectId, 'asr:whisper-asr', data, 180000);
    console.log(`OK   ${label}: ${JSON.stringify(r).slice(0, 200)}`);
  } catch (e) {
    console.log(`FAIL ${label}: ${e.message} (status ${e.status})`);
  }
}
