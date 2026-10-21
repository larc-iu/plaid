import { describe, it, expect } from 'vitest';
import { applyMetadataOps } from '@larc-iu/plaid-client';
import {
  isPublished,
  publicationCounts,
  publishAll,
  statusKeyOf,
  statusOf,
} from './publication.js';
import { normalizeVocabFields } from '@igt/domain/vocabFields.js';

const entry = (id, status) => ({ id, metadata: status ? { status } : {} });

describe('statusOf / isPublished', () => {
  it('reads the status field, and nothing else counts as published', () => {
    expect(statusOf(entry('a', 'draft'), 'status')).toBe('draft');
    expect(statusOf(entry('a'), 'status')).toBe('');
    expect(statusOf({ id: 'a', metadata: { status: 3 } }, 'status')).toBe('');
    expect(isPublished(entry('a', 'published'), 'status')).toBe(true);
    expect(isPublished(entry('a', 'reviewed'), 'status')).toBe(false);
    expect(isPublished(entry('a'), 'status')).toBe(false);
  });
});

describe('the status key', () => {
  it('is always named: a read without it throws rather than look under status', () => {
    // A default of `status` hid every entry of a vocabulary that spells it "Status".
    const items = [{ id: 'a', metadata: { Status: 'published' } }];
    expect(() => statusOf(items[0])).toThrow(TypeError);
    expect(() => isPublished(items[0])).toThrow(TypeError);
    expect(() => publicationCounts(items)).toThrow(TypeError);
    expect(isPublished(items[0], 'Status')).toBe(true);
    expect(publicationCounts(items, 'Status')).toEqual({ published: 1, total: 1 });
  });

  it('is null for a vocabulary with no status field, and nothing is published', () => {
    const items = [entry('a', 'published')];
    expect(statusKeyOf(normalizeVocabFields({ status: { inline: false } }))).toBeNull();
    expect(isPublished(items[0], null)).toBe(false);
    expect(publicationCounts(items, null)).toEqual({ published: 0, total: 1 });
  });
});

describe('publicationCounts', () => {
  it('counts published against the whole vocabulary', () => {
    const items = [entry('a', 'published'), entry('b', 'draft'), entry('c')];
    expect(publicationCounts(items, 'status')).toEqual({ published: 1, total: 3 });
    expect(publicationCounts([], 'status')).toEqual({ published: 0, total: 0 });
    expect(publicationCounts(null, 'status')).toEqual({ published: 0, total: 0 });
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
      // The batch the block writes on: the same bundle, queuing into `patched`.
      // A write made on the client itself is not part of a batch.
      async batched(fn) {
        const before = patched.length;
        await fn({ vocabItems: this.vocabItems });
        chunks.push(patched.length - before);
      },
      vocabItems: {
        // The server takes a list of path ops and refuses anything else.
        patchMetadata: (id, ops) => {
          if (!Array.isArray(ops)) throw new Error('Request validation failed. invalid type');
          patched.push([id, applyMetadataOps({}, ops)]);
        },
      },
      configs: [],
      // What the SERVER holds right now, which is what publishAll must read.
      layer: {
        id: 'v',
        config: { igt: { fields: { gloss: { inline: true }, status: { role: 'status' } } } },
        items: [entry('a')],
      },
      vocabLayers: {
        get: async () => client.layer,
        setConfig(id, ns, key, value) {
          client.configs.push([key, value]);
        },
      },
    };
    return client;
  };

  it('writes under the key of the field whose role is status, and declares nothing', async () => {
    const client = fakeClient();
    client.layer = {
      id: 'v',
      config: { igt: { fields: { gloss: {}, Stage: { inline: true, role: 'status' } } } },
    };
    client.layer.items = [entry('a'), { id: 'b', metadata: { Stage: 'published' } }];
    const n = await publishAll(client, { vocabularyId: 'v' });
    expect(n).toBe(1);
    expect(client.configs).toEqual([]);
    expect(client.patched).toEqual([['a', { Stage: 'published' }]]);
  });

  it('sends each entry one set op on the status key, never a merge object', async () => {
    // Core took `{status: 'published'}` as a shallow merge once; it now takes
    // path ops only and refused the whole batch with a 400.
    const client = fakeClient();
    const sent = [];
    client.vocabItems.patchMetadata = (id, ops) => sent.push([id, ops]);
    client.layer.items = [entry('a'), entry('b', 'draft')];
    await publishAll(client, { vocabularyId: 'v' });
    expect(sent).toEqual([
      ['a', [{ op: 'set', path: ['status'], value: 'published' }]],
      ['b', [{ op: 'set', path: ['status'], value: 'published' }]],
    ]);
  });

  it('refuses on a vocabulary with no field holding the Status role, and writes nothing', async () => {
    // A role is never given from a name, and a role a maintainer cleared
    // stays cleared: Publish all has no field to write and says so.
    for (const fields of [{ gloss: { inline: true } }, { Status: { inline: true } }]) {
      const client = fakeClient();
      client.layer = { id: 'v', config: { igt: { fields } }, items: [entry('a')] };
      await expect(publishAll(client, { vocabularyId: 'v', name: 'Sena' })).rejects.toThrow(
        'No field has the Status role',
      );
      expect(client.configs).toEqual([]);
      expect(client.patched).toEqual([]);
    }
  });

  it('leaves the schema alone when Status is already declared', async () => {
    const client = fakeClient();
    client.layer = {
      id: 'v',
      config: {
        igt: {
          fields: { status: { inline: false, tagset: 'Status', role: 'status' } },
          tagsets: { Status: {} },
        },
      },
      items: [entry('a')],
    };
    await publishAll(client, { vocabularyId: 'v' });
    expect(client.configs).toEqual([]);
  });

  it('patches only the entries that are not published yet', async () => {
    const client = fakeClient();
    client.layer.items = [entry('a', 'published'), entry('b', 'draft'), entry('c')];
    const n = await publishAll(client, { vocabularyId: 'v', name: 'Sena' });
    expect(n).toBe(2);
    expect(client.patched).toEqual([
      ['b', { status: 'published' }],
      ['c', { status: 'published' }],
    ]);
    expect(client.operations).toEqual(['Publish every entry in "Sena"']);
  });

  it('writes nothing when everything is already published', async () => {
    const client = fakeClient();
    client.layer.items = [entry('a', 'published')];
    const n = await publishAll(client, { vocabularyId: 'v' });
    expect(n).toBe(0);
    expect(client.operations).toEqual([]);
  });

  // A server that holds `layer.items` and refuses a whole batch, as core does,
  // when one of its ids is gone. `beforeSend` runs ahead of each batch.
  const strictClient = (items, beforeSend) => {
    const client = fakeClient();
    client.layer = { ...client.layer, items };
    let sends = 0;
    client.batched = async (fn) => {
      const queued = [];
      await fn({ vocabItems: { patchMetadata: (id, ops) => queued.push([id, ops]) } });
      beforeSend?.(sends++, client);
      const gone = queued.find(([id]) => !client.layer.items.some((it) => it.id === id));
      if (gone) {
        const err = new Error(`Vocab item not found with id \`${gone[0]}\``);
        err.status = 404;
        throw err;
      }
      for (const [id, ops] of queued) {
        const it = client.layer.items.find((x) => x.id === id);
        it.metadata = applyMetadataOps(it.metadata, ops);
        client.patched.push([id, it.metadata]);
      }
      client.chunks.push(queued.length);
    };
    return client;
  };

  it('publishes what the server holds, not an entry list that has gone stale', async () => {
    // Setup loads the entries once. An entry deleted in plaid-igt since then
    // made core refuse the whole batch, and every retry resent the same id.
    const server = ['a', 'b', 'c'].map((id) => entry(id));
    const client = strictClient(server);
    const n = await publishAll(client, { vocabularyId: 'v' });
    expect(n).toBe(3);
    client.layer.items = client.layer.items.filter((it) => it.id !== 'b');
    client.layer.items.push(entry('d'));
    const again = await publishAll(client, { vocabularyId: 'v' });
    expect(again).toBe(1);
    expect(client.layer.items.every((it) => isPublished(it, 'status'))).toBe(true);
  });

  it('publishes the rest when an entry is deleted while it runs', async () => {
    const server = Array.from({ length: 450 }, (_, i) => entry(`e${i}`));
    const client = strictClient(server, (send, c) => {
      // Before the second batch goes out, someone deletes one of its entries.
      if (send === 1) c.layer.items = c.layer.items.filter((it) => it.id !== 'e250');
    });
    const n = await publishAll(client, { vocabularyId: 'v' });
    expect(n).toBe(449);
    expect(client.layer.items).toHaveLength(449);
    expect(client.layer.items.every((it) => isPublished(it, 'status'))).toBe(true);
  });

  it('still fails on an error that is not a deleted entry', async () => {
    const client = strictClient([entry('a')]);
    client.batched = async () => {
      const err = new Error('Forbidden');
      err.status = 403;
      throw err;
    };
    await expect(publishAll(client, { vocabularyId: 'v' })).rejects.toThrow('Forbidden');
  });

  it('splits the writes into batches and reports progress per batch', async () => {
    const client = fakeClient();
    client.layer.items = Array.from({ length: 450 }, (_, i) => entry(`e${i}`));
    const progress = [];
    const n = await publishAll(client, {
      vocabularyId: 'v',
      onProgress: (p) => progress.push(p.done),
    });
    expect(n).toBe(450);
    expect(client.chunks).toEqual([200, 200, 50]);
    expect(progress).toEqual([200, 400, 450]);
  });
});
