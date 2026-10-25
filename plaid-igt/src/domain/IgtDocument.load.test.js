import { describe, it, expect } from 'vitest';
import { IgtDocument } from './IgtDocument.js';
import { buildRawDoc } from './test-helpers.js';

// IgtDocument.load reads the document beside the project and the project's
// vocabularies (DocumentModel.load and IgtDocument._loadBeside): the project
// read first when the caller has not started one, the document next, and the
// vocabularies once the project is in. A past state reads the document and
// the vocabularies as they were then.

const load = (client, options) => IgtDocument.load(client, options);

const PROJECT = { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } };
const VOCAB = { id: 'v1', name: 'Lexicon', items: [], timeModified: null };

// A client that records each read, in the order it was asked, with the
// arguments given (an undefined trailing argument left out, which the wire
// leaves out too).
function recordingClient() {
  const reads = [];
  const note = (kind, args) => {
    const given = [...args];
    while (given.length && given.at(-1) === undefined) given.pop();
    reads.push([kind, ...given]);
  };
  const client = {
    reads,
    projects: {
      get: async (...args) => {
        note('projects.get', args);
        return structuredClone(PROJECT);
      },
    },
    documents: {
      get: async (...args) => {
        note('documents.get', args);
        return buildRawDoc();
      },
    },
    vocabLayers: {
      get: async (...args) => {
        note('vocabLayers.get', args);
        return structuredClone(VOCAB);
      },
    },
  };
  return client;
}

describe('IgtDocument.load', () => {
  it('reads the project, then the document, then the vocabularies', async () => {
    const client = recordingClient();
    const user = { id: 'a@b.c' };
    const doc = await load(client, { projectId: 'proj-1', documentId: 'd1', user });
    expect(client.reads).toEqual([
      ['projects.get', 'proj-1'],
      ['documents.get', 'd1', true],
      ['vocabLayers.get', 'v1'],
      ['vocabLayers.get', 'v1', true],
    ]);
    expect(doc).toBeInstanceOf(IgtDocument);
    expect(doc.project).toEqual(PROJECT);
    expect(Object.keys(doc.vocabularies)).toEqual(['v1']);
    expect(doc.asOf).toBe(null);
    expect(doc.user).toBe(user);
    expect(doc.client).toBe(client);
  });

  it('takes a project read the caller started, and reads no project itself', async () => {
    const client = recordingClient();
    const project = Promise.resolve(structuredClone(PROJECT));
    const doc = await load(client, { projectId: 'proj-1', documentId: 'd1', project });
    expect(client.reads.map(([kind]) => kind)).toEqual([
      'documents.get',
      'vocabLayers.get',
      'vocabLayers.get',
    ]);
    expect(doc.project).toEqual(PROJECT);
  });

  it('reads a past state of the document and of its vocabularies', async () => {
    const client = recordingClient();
    const asOf = '2026-01-02T03:04:05Z';
    const doc = await load(client, { projectId: 'proj-1', documentId: 'd1', asOf });
    expect(client.reads).toEqual([
      ['projects.get', 'proj-1'],
      ['documents.get', 'd1', true, asOf],
      ['vocabLayers.get', 'v1', true, asOf],
    ]);
    expect(doc.asOf).toBe(asOf);
  });
});
