import { describe, it, expect, vi, beforeEach } from 'vitest';

let decodes;
vi.mock('./decodeTo16kMono.js', () => ({
  decodeTo16k: vi.fn(
    (blob, options) =>
      new Promise((resolve) => {
        decodes.push({ resolve, options });
      }),
  ),
}));
const { decodeShared } = await import('./sharedDecode.js');

beforeEach(() => {
  decodes = [];
});

const landed = (mono, channels = null) => ({
  mono,
  channels,
  channelCount: channels?.length ?? 1,
});

describe('decodeShared', () => {
  it('runs one decode for two callers at once, and says it is shared', async () => {
    const blob = {};
    const a = decodeShared(blob);
    const b = decodeShared(blob);
    expect(decodes).toHaveLength(1);
    const samples = new Float32Array([1, 2]);
    decodes[0].resolve(landed(samples));
    expect(await a).toEqual({ samples, channels: null, channelCount: 1, shared: true });
    expect(await b).toEqual({ samples, channels: null, channelCount: 1, shared: true });
  });

  it('keeps nothing once it lands: a later call decodes again, unshared', async () => {
    const blob = {};
    const first = decodeShared(blob);
    decodes[0].resolve(landed(new Float32Array([1])));
    expect((await first).shared).toBe(false);
    const again = decodeShared(blob);
    expect(decodes).toHaveLength(2);
    decodes[1].resolve(landed(new Float32Array([2])));
    expect((await again).shared).toBe(false);
  });

  it('hands the channels on when asked for them, and a mix-only caller joins that decode', async () => {
    const blob = {};
    const a = decodeShared(blob, { perChannel: true });
    const b = decodeShared(blob);
    expect(decodes).toHaveLength(1);
    expect(decodes[0].options).toEqual({ perChannel: true });
    const left = new Float32Array([1]);
    const right = new Float32Array([0]);
    decodes[0].resolve(landed(new Float32Array([0.5]), [left, right]));
    expect((await a).channels).toEqual([left, right]);
    expect((await b).channelCount).toBe(2);
  });

  it('a caller wanting the channels does not join a mix-only decode', async () => {
    const blob = {};
    decodeShared(blob);
    decodeShared(blob, { perChannel: true });
    expect(decodes.map((d) => d.options)).toEqual([{ perChannel: false }, { perChannel: true }]);
  });
});
