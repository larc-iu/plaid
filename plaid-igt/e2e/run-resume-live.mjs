// Sets up a throwaway document for exercising a real service run in the
// browser: the write lock, rejoin-after-reload, and Cancel.
//
//   node e2e/run-resume-live.mjs [sourceDocumentId]
//
// With a source document, its media is copied over, so the run is long enough
// to reload or cancel in the middle of. Without one, a short synthetic tone is
// uploaded instead, which is enough to watch a run start and finish.
import { makeClient, getFixtureProjectId, freshDoc, wavBytes } from './bugbash/harness.mjs';

const client = makeClient();
const projectId = await getFixtureProjectId(client);
const sourceId = process.argv[2];

const { documentId } = await freshDoc(client, projectId, {
  body: 'the quick brown fox jumps over the lazy dog',
  name: `Run resume probe ${Date.now()}`,
});

let file;
if (sourceId) {
  const source = await client.documents.get(sourceId);
  const url = source.mediaUrl.startsWith('/') ? `${client.baseUrl}${source.mediaUrl}` : source.mediaUrl;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${client.token}` } });
  if (!res.ok) throw new Error(`could not read the source media: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  file = new File([bytes], 'copied.mp3', { type: res.headers.get('content-type') || 'audio/mpeg' });
  console.error(`copied ${bytes.length} bytes of media from ${sourceId}`);
} else {
  file = new File([wavBytes(6)], 'probe.wav', { type: 'audio/wav' });
}

await client.documents.uploadMedia(documentId, file);
console.log(JSON.stringify({ projectId, documentId }));
