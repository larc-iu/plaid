import { describe, it, expect, vi } from 'vitest';
import { WriteQueue } from './WriteQueue.js';
import { keyedSend } from './keyedSend.js';

// A queued write under keys fixed when it is queued (REV4 J3), and a planned
// write that plans once (A3-1).

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
      return fn(() => {});
    },
  };
};

const queue = () => new WriteQueue({ retryDelay: () => 0 });

describe('keyedSend', () => {
  it('sends a write whose answer was lost again, under the same operation and keys, until it lands', async () => {
    const client = fakeClient();
    let tries = 0;
    const landed = await keyedSend(queue(), client, 'Rename vocabulary', async () => {
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
    const refused = vi.fn();
    const landed = await keyedSend(
      queue(),
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

  it("gives the operation its minted ids and tags beside the send's own group and keys", async () => {
    const client = fakeClient();
    await keyedSend(queue(), client, 'Bulk Add', async () => {}, {
      minted: ['m1'],
      kind: 'import',
      ref: 'format:table',
    });
    const [{ opts }] = client.ops;
    expect(opts).toMatchObject({ minted: ['m1'], kind: 'import', ref: 'format:table' });
    expect(opts.keys).toEqual({ seed: 'seed1' });
    expect(typeof opts.groupId).toBe('string');
  });

  it('plans once, and hands every send what it planned', async () => {
    const client = fakeClient();
    let plans = 0;
    const seen = [];
    let fail = 2;
    const landed = await keyedSend(
      queue(),
      client,
      'Replace',
      async (_setMessage, planned) => {
        seen.push(planned);
        if (fail-- > 0) throw lost('PATCH');
      },
      { plan: async () => ({ plan: (plans += 1) }) },
    );
    expect(landed).toBe(true);
    expect(plans).toBe(1);
    expect(seen).toEqual([{ plan: 1 }, { plan: 1 }, { plan: 1 }]);
  });

  it('tries a plan the network failed again, and refuses one the server refused', async () => {
    const client = fakeClient();
    let reads = 0;
    const write = vi.fn(async () => {});
    const landed = await keyedSend(queue(), client, 'Prune', write, {
      plan: async () => {
        reads += 1;
        if (reads === 1) throw lost('GET');
        return ['w'];
      },
    });
    expect(landed).toBe(true);
    expect(reads).toBe(2);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][1]).toEqual(['w']);

    const refused = vi.fn();
    const changed = await keyedSend(queue(), client, 'Bulk Add', write, {
      plan: async () => {
        throw new Error('changed since the review');
      },
      refused,
    });
    expect(changed).toBe(false);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
