import { describe, it, expect } from 'vitest';
import { bulkInChunks, CHUNK } from './bulk.js';

describe('bulkInChunks', () => {
  const items = Array.from({ length: CHUNK + 3 }, (_, i) => i);

  it('gives one id per item, in order, over every chunk', async () => {
    const ids = await bulkInChunks(items, null, async (slice) => ({
      ids: slice.map((i) => `id${i}`),
    }));
    expect(ids).toEqual(items.map((i) => `id${i}`));
  });

  it('throws when an answer lists fewer ids than the rows it was sent', async () => {
    await expect(
      bulkInChunks(items, null, async (slice) => ({ ids: slice.slice(1).map(String) })),
    ).rejects.toThrow(`The server answered ${CHUNK - 1} ids for ${CHUNK} rows.`);
  });

  it('takes an answer with no ids, as an update gives', async () => {
    expect(await bulkInChunks(items, null, async () => undefined)).toEqual([]);
  });
});
