import { describe, it, expect, vi } from 'vitest';
import { WriteQueue } from '@ui/domain/WriteQueue.js';
import { sendKeyed, sendFieldPrune } from './vocabSends.js';

// REV4 J3: the vocabulary's settings writes and the field-value prune go under
// operation keys, and a send whose answer was lost goes again under them until
// it is answered, like every other write.

const lost = (method = 'PUT') =>
  Object.assign(new Error('Network error: fetch failed at http://x/api/v1/vocab-layers/A'), {
    status: 0,
    method,
  });

const fakeClient = () => {
  const ops = [];
  let seed = 0;
  return {
    ops,
    keySeed: () => ({ seed: `seed${(seed += 1)}` }),
    withOperation: async (label, fn, opts) => {
      ops.push({ label, opts });
      return fn();
    },
  };
};

describe('sendKeyed', () => {
  it('sends a write whose answer was lost again, under the same operation and keys, until it lands', async () => {
    const client = fakeClient();
    const queue = new WriteQueue({ retryDelay: () => 0 });
    let tries = 0;
    const landed = await sendKeyed(queue, client, 'Rename vocabulary', async () => {
      tries += 1;
      if (tries < 4) throw lost();
    });
    expect(landed).toBe(true);
    expect(tries).toBe(4);
    expect(client.ops.map((o) => o.label)).toEqual(Array(4).fill('Rename vocabulary'));
    expect(new Set(client.ops.map((o) => o.opts)).size).toBe(1);
    expect(client.ops[0].opts.keys).toEqual({ seed: 'seed1' });
  });

  it('refuses a write the server refused, once', async () => {
    const client = fakeClient();
    const queue = new WriteQueue({ retryDelay: () => 0 });
    const refused = vi.fn();
    const landed = await sendKeyed(
      queue,
      client,
      'Change the fields',
      async () => {
        throw Object.assign(new Error('HTTP 409'), { status: 409, method: 'PUT' });
      },
      { refused },
    );
    expect(landed).toBe(false);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(client.ops).toHaveLength(1);
  });
});

describe('sendFieldPrune', () => {
  const after = { name: 'ref', type: 'text' };
  const items = [
    { id: 'a', form: 'a', metadata: { ref: 'b' } },
    { id: 'b', form: 'b', metadata: { ref: 'a' } },
  ];

  it('sends the writes it planned again, as planned, when an answer was lost', async () => {
    const client = fakeClient();
    let reads = 0;
    const sent = [];
    let fail = 1;
    client.vocabLayers = {
      get: async () => {
        reads += 1;
        if (reads === 1) throw lost('GET');
        // What the first send changed shows in a later read.
        return { items: sent.length ? [] : items };
      },
    };
    client.vocabItems = {
      bulkUpdate: async (updates) => {
        sent.push(updates);
        if (fail-- > 0) throw lost('PATCH');
      },
    };
    const queue = new WriteQueue({ retryDelay: () => 0 });
    const landed = await sendFieldPrune({
      queue,
      client,
      vocabularyId: 'A',
      after,
      label: 'Ref',
      refused: vi.fn(),
    });
    expect(landed).toBe(true);
    expect(reads).toBe(2);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0].map((u) => u.id)).toEqual(['a', 'b']);
    expect(new Set(client.ops.map((o) => o.opts)).size).toBe(1);
  });

  it('tells the caller a refused prune', async () => {
    const client = fakeClient();
    client.vocabLayers = { get: async () => ({ items }) };
    client.vocabItems = {
      bulkUpdate: async () => {
        throw Object.assign(new Error('HTTP 500'), { status: 500, method: 'PATCH' });
      },
    };
    const refused = vi.fn();
    const queue = new WriteQueue({ retryDelay: () => 0 });
    const landed = await sendFieldPrune({
      queue,
      client,
      vocabularyId: 'A',
      after,
      label: 'Ref',
      refused,
    });
    expect(landed).toBe(false);
    expect(refused).toHaveBeenCalledTimes(1);
  });
});
