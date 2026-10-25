// The fidelity snapshot downloads each recording to hash it. A long recording
// takes longer than the client's default 30 s timeout, so the download asks for
// none, as the export's does (export/runExport.js).
import { it, expect } from 'vitest';
import { snapshotProject } from '../../../e2e/fidelity/snapshot.mjs';

it('a snapshot downloads a recording with no timeout', async () => {
  const asked = [];
  const client = {
    projects: {
      get: async () => ({ id: 'p', textLayers: [], vocabs: [] }),
      listDocuments: async () => [{ id: 'd', name: 'Talk' }],
    },
    documents: {
      get: async () => ({ id: 'd', mediaUrl: '/media/d', textLayers: [] }),
      getMedia: async (id, options) => {
        asked.push([id, options]);
        return new Uint8Array([1, 2, 3]).buffer;
      },
    },
    vocabLayers: { get: async () => null },
    comments: { list: async () => [], listInVocab: async () => [] },
    guidelines: { list: async () => [] },
  };
  const snap = await snapshotProject(client, 'p');
  expect(asked).toEqual([['d', { timeout: null }]]);
  expect(snap.documents[0].media.bytes).toBe(3);
});
