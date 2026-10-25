import { describe, it, expect } from 'vitest';
import { DocumentModel } from './DocumentModel.js';

// The one load every model shares: the document read beside what the
// subclass's `_loadBeside` reads, both handed to the subclass's constructor.

function recordingClient() {
  const reads = [];
  return {
    reads,
    documents: {
      get: async (...args) => {
        reads.push(['documents.get', ...args]);
        return { id: args[0], textLayers: [] };
      },
    },
  };
}

class Plain extends DocumentModel {}

class WithShelf extends DocumentModel {
  constructor({ shelf = null, ...rest }) {
    super(rest);
    this.shelf = shelf;
  }

  static async _loadBeside(client, { projectId, asOf, project }) {
    client.reads.push(['beside', projectId, asOf]);
    return { project: (await project) ?? { id: projectId }, shelf: 'kept' };
  }
}

describe('DocumentModel.load', () => {
  it('reads the live document and makes an instance of the class it is called on', async () => {
    const client = recordingClient();
    const user = { id: 'a@b.c' };
    const project = { id: 'p1' };
    const doc = await Plain.load(client, { projectId: 'p1', documentId: 'd1', project, user });
    expect(client.reads).toEqual([['documents.get', 'd1', true]]);
    expect(doc).toBeInstanceOf(Plain);
    expect(doc.id).toBe('d1');
    expect(doc.project).toBe(project);
    expect(doc.user).toBe(user);
    expect(doc.asOf).toBe(null);
  });

  it('reads a past state at asOf and keeps it', async () => {
    const client = recordingClient();
    const asOf = '2026-01-02T03:04:05Z';
    const doc = await Plain.load(client, { projectId: 'p1', documentId: 'd1', asOf });
    expect(client.reads).toEqual([['documents.get', 'd1', true, asOf]]);
    expect(doc.asOf).toBe(asOf);
  });

  it('waits for a project read the caller started', async () => {
    const client = recordingClient();
    const project = { id: 'p1' };
    const doc = await Plain.load(client, {
      projectId: 'p1',
      documentId: 'd1',
      project: Promise.resolve(project),
    });
    expect(doc.project).toBe(project);
  });

  it("hands what _loadBeside reads to the subclass's constructor, read before the document", async () => {
    const client = recordingClient();
    const doc = await WithShelf.load(client, { projectId: 'p1', documentId: 'd1' });
    expect(client.reads).toEqual([
      ['beside', 'p1', null],
      ['documents.get', 'd1', true],
    ]);
    expect(doc).toBeInstanceOf(WithShelf);
    expect(doc.shelf).toBe('kept');
    expect(doc.project).toEqual({ id: 'p1' });
  });

  it('fails when the document read fails', async () => {
    const client = {
      reads: [],
      documents: {
        get: async () => {
          throw Object.assign(new Error('HTTP 404'), { status: 404 });
        },
      },
    };
    await expect(Plain.load(client, { projectId: 'p1', documentId: 'd1' })).rejects.toThrow(
      'HTTP 404',
    );
  });
});
