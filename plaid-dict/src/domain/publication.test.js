import { describe, it, expect } from 'vitest';
import { isPublished, publicationCounts, publishAll, statusOf } from './publication.js';

const entry = (id, status) => ({ id, metadata: status ? { status } : {} });

describe('statusOf / isPublished', () => {
  it('reads the status field, and nothing else counts as published', () => {
    expect(statusOf(entry('a', 'draft'))).toBe('draft');
    expect(statusOf(entry('a'))).toBe('');
    expect(statusOf({ id: 'a', metadata: { status: 3 } })).toBe('');
    expect(isPublished(entry('a', 'published'))).toBe(true);
    expect(isPublished(entry('a', 'reviewed'))).toBe(false);
    expect(isPublished(entry('a'))).toBe(false);
  });
});

describe('publicationCounts', () => {
  it('counts published against the whole vocabulary', () => {
    const items = [entry('a', 'published'), entry('b', 'draft'), entry('c')];
    expect(publicationCounts(items)).toEqual({ published: 1, total: 3 });
    expect(publicationCounts([])).toEqual({ published: 0, total: 0 });
    expect(publicationCounts(null)).toEqual({ published: 0, total: 0 });
  });
});

describe('publishAll', () => {
  const fakeClient = () => {
    const patched = [];
    const chunks = [];
    const client = {
      patched,
      chunks,
      operations: [],
      withOperation(message, fn) {
        this.operations.push(message);
        return fn();
      },
      async batched(fn) {
        const before = patched.length;
        await fn();
        chunks.push(patched.length - before);
      },
      vocabItems: {
        patchMetadata: (id, patch) => patched.push([id, patch]),
      },
      configs: [],
      // What the SERVER holds right now, which is what publishAll must read.
      layer: { id: 'v', config: { igt: { fields: { gloss: { inline: true } } } } },
      vocabLayers: {
        get: async () => client.layer,
        setConfig(id, ns, key, value) {
          client.configs.push([key, value]);
        },
      },
    };
    return client;
  };

  it('writes under the key the vocabulary declares, in whatever case, and declares nothing', async () => {
    const client = fakeClient();
    client.layer = {
      id: 'v',
      config: { igt: { fields: { gloss: {}, Status: { inline: true } } } },
    };
    const items = [entry('a'), { id: 'b', metadata: { Status: 'published' } }];
    const n = await publishAll(client, items, { vocabularyId: 'v' });
    expect(n).toBe(1);
    expect(client.configs).toEqual([]);
    expect(client.patched).toEqual([['a', { Status: 'published' }]]);
  });

  it('declares the Status field first on a vocabulary that has none', async () => {
    // A value under a field the schema does not name is invisible in
    // plaid-igt: no control on the entry, nothing in Bulk Edit.
    const client = fakeClient();
    await publishAll(client, [entry('a')], { vocabularyId: 'v', name: 'Sena' });
    expect(client.configs.map(([k]) => k)).toEqual(['tagsets', 'fields']);
    expect(client.configs.find(([k]) => k === 'fields')[1].status).toEqual({
      inline: false,
      tagset: 'Status',
    });
    expect(client.configs.find(([k]) => k === 'tagsets')[1].Status.mode).toBe('closed');
    // One operation covers the schema write and the entries alike.
    expect(client.operations).toEqual(['Publish every entry in "Sena"']);
  });

  it('keeps every field and tagset the server holds now, not what was cached', async () => {
    // The catalog is loaded once at app start, and setConfig replaces a
    // namespace key wholesale. Writing from the snapshot deleted whatever
    // plaid-igt had added in the other tab since.
    const client = fakeClient();
    client.layer = {
      id: 'v',
      config: {
        igt: {
          fields: { gloss: { inline: true }, etymology: { inline: false } },
          tagsets: { Register: { mode: 'closed', values: [{ value: 'formal' }] } },
        },
      },
    };
    await publishAll(client, [entry('a')], { vocabularyId: 'v' });
    const fields = client.configs.find(([k]) => k === 'fields')[1];
    const tagsets = client.configs.find(([k]) => k === 'tagsets')[1];
    expect(Object.keys(fields).sort()).toEqual(['etymology', 'gloss', 'status']);
    expect(Object.keys(tagsets).sort()).toEqual(['Register', 'Status']);
    // Verbatim, so a tagset key this app does not know survives the write.
    expect(tagsets.Register).toEqual({ mode: 'closed', values: [{ value: 'formal' }] });
  });

  it('takes a user\'s own "Status" field as this one, so no pair is made', async () => {
    // plaid-igt's field editor rejects a duplicate case-insensitively, and
    // seeds nothing beside such a field. Testing the exact key here rebuilt
    // the very pair it refuses: two fields both labelled Status, writing
    // different metadata keys, only one of which is published by.
    const client = fakeClient();
    client.layer = { id: 'v', config: { igt: { fields: { Status: { inline: true } } } } };
    await publishAll(client, [entry('a')], { vocabularyId: 'v' });
    expect(client.configs).toEqual([]);
  });

  it('leaves the schema alone when Status is already declared', async () => {
    const client = fakeClient();
    client.layer = {
      id: 'v',
      config: {
        igt: { fields: { status: { inline: false, tagset: 'Status' } }, tagsets: { Status: {} } },
      },
    };
    await publishAll(client, [entry('a')], { vocabularyId: 'v' });
    expect(client.configs).toEqual([]);
  });

  it('patches only the entries that are not published yet', async () => {
    const client = fakeClient();
    const items = [entry('a', 'published'), entry('b', 'draft'), entry('c')];
    const n = await publishAll(client, items, { vocabularyId: 'v', name: 'Sena' });
    expect(n).toBe(2);
    expect(client.patched).toEqual([
      ['b', { status: 'published' }],
      ['c', { status: 'published' }],
    ]);
    expect(client.operations).toEqual(['Publish every entry in "Sena"']);
  });

  it('writes nothing when everything is already published', async () => {
    const client = fakeClient();
    const n = await publishAll(client, [entry('a', 'published')], { vocabularyId: 'v' });
    expect(n).toBe(0);
    expect(client.operations).toEqual([]);
  });

  it('splits the writes into batches and reports progress per batch', async () => {
    const client = fakeClient();
    const items = Array.from({ length: 450 }, (_, i) => entry(`e${i}`));
    const progress = [];
    const n = await publishAll(client, items, {
      vocabularyId: 'v',
      onProgress: (p) => progress.push(p.done),
    });
    expect(n).toBe(450);
    expect(client.chunks).toEqual([200, 200, 50]);
    expect(progress).toEqual([200, 400, 450]);
  });
});
