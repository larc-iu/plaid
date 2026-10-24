import { describe, it, expect } from 'vitest';
import { bulkInChunks, CHUNK, withMintedIds } from './bulk.js';

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

describe('withMintedIds', () => {
  it('keeps an id a spec names and mints one for a spec without', () => {
    const [named, bare] = withMintedIds([{ id: 'a', v: 1 }, { v: 2 }]);
    expect(named).toEqual({ id: 'a', v: 1 });
    expect(bare.v).toBe(2);
    expect(bare.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('mints an id for a spec whose id key holds nothing', () => {
    const out = withMintedIds([
      { id: undefined, v: 1 },
      { id: null, v: 2 },
    ]);
    for (const s of out) expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
