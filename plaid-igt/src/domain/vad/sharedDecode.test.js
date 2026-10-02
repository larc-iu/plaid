import { describe, it, expect, vi, beforeEach } from 'vitest';

let decodes;
vi.mock('./decodeTo16kMono.js', () => ({
  decodeTo16kMono: vi.fn(
    () =>
      new Promise((resolve) => {
        decodes.push(resolve);
      }),
  ),
}));
const { decodeShared } = await import('./sharedDecode.js');

beforeEach(() => {
  decodes = [];
});

describe('decodeShared', () => {
  it('runs one decode for two callers at once, and says it is shared', async () => {
    const blob = {};
    const a = decodeShared(blob);
    const b = decodeShared(blob);
    expect(decodes).toHaveLength(1);
    const samples = new Float32Array([1, 2]);
    decodes[0](samples);
    expect(await a).toEqual({ samples, shared: true });
    expect(await b).toEqual({ samples, shared: true });
  });

  it('keeps nothing once it lands: a later call decodes again, unshared', async () => {
    const blob = {};
    const first = decodeShared(blob);
    decodes[0](new Float32Array([1]));
    expect((await first).shared).toBe(false);
    const again = decodeShared(blob);
    expect(decodes).toHaveLength(2);
    decodes[1](new Float32Array([2]));
    expect((await again).shared).toBe(false);
  });
});
