// ConlluDocument.load reads the document and wraps it with the project and the person
// writing (DocumentModel.load). A project read the caller started is waited
// for beside the document, and nothing else is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';

const load = (client, options) => ConlluDocument.load(client, options);

const PROJECT = { id: 'p1', config: {} };

function recordingClient() {
  const reads = [];
  return {
    reads,
    projects: {
      get: async (...args) => {
        reads.push(['projects.get', ...args]);
        return PROJECT;
      },
    },
    documents: {
      get: async (...args) => {
        reads.push(['documents.get', ...args]);
        return { id: args[0], textLayers: [] };
      },
    },
  };
}

test('load reads the document alone and wraps it with the project and the user', async () => {
  const client = recordingClient();
  const user = { id: 'a@b.c' };
  const doc = await load(client, { projectId: 'p1', documentId: 'd1', project: PROJECT, user });
  assert.deepEqual(client.reads, [['documents.get', 'd1', true]]);
  assert.ok(doc instanceof ConlluDocument);
  assert.equal(doc.id, 'd1');
  assert.equal(doc.project, PROJECT);
  assert.equal(doc.user, user);
  assert.equal(doc.asOf, null);
  assert.equal(doc.client, client);
});

test('load waits for a project read the caller started', async () => {
  const client = recordingClient();
  const doc = await load(client, {
    projectId: 'p1',
    documentId: 'd1',
    project: Promise.resolve(PROJECT),
  });
  assert.deepEqual(client.reads, [['documents.get', 'd1', true]]);
  assert.equal(doc.project, PROJECT);
});

test('load with no project reads none, and the document has none', async () => {
  const client = recordingClient();
  const doc = await load(client, { projectId: 'p1', documentId: 'd1' });
  assert.deepEqual(client.reads, [['documents.get', 'd1', true]]);
  assert.equal(doc.project, null);
  assert.equal(doc.user, null);
});
