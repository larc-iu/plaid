// Throwaway document with audio, for driving a real service run in the browser.
// Live scratch script (see CLAUDE.md: e2e/*-live.mjs and probes live here).
import { makeClient, getFixtureProjectId, freshDoc, wavBytes } from './bugbash/harness.mjs';

const client = makeClient();
const projectId = await getFixtureProjectId(client);
const { documentId } = await freshDoc(client, projectId, {
  body: 'the quick brown fox jumps over the lazy dog',
  name: `Run resume probe ${Date.now()}`,
});
const file = new File([wavBytes(6)], 'probe.wav', { type: 'audio/wav' });
await client.documents.uploadMedia(documentId, file);
console.log(JSON.stringify({ projectId, documentId }));
