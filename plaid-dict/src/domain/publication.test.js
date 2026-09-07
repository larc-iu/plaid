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
    return {
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
    };
  };

  it('patches only the entries that are not published yet', async () => {
    const client = fakeClient();
    const items = [entry('a', 'published'), entry('b', 'draft'), entry('c')];
    const n = await publishAll(client, items, { name: 'Sena' });
    expect(n).toBe(2);
    expect(client.patched).toEqual([
      ['b', { status: 'published' }],
      ['c', { status: 'published' }],
    ]);
    expect(client.operations).toEqual(['Publish every entry in "Sena"']);
  });

  it('writes nothing when everything is already published', async () => {
    const client = fakeClient();
    const n = await publishAll(client, [entry('a', 'published')]);
    expect(n).toBe(0);
    expect(client.operations).toEqual([]);
  });

  it('splits the writes into batches and reports progress per batch', async () => {
    const client = fakeClient();
    const items = Array.from({ length: 450 }, (_, i) => entry(`e${i}`));
    const progress = [];
    const n = await publishAll(client, items, { onProgress: (p) => progress.push(p.done) });
    expect(n).toBe(450);
    expect(client.chunks).toEqual([200, 200, 50]);
    expect(progress).toEqual([200, 400, 450]);
  });
});
