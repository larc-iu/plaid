import { describe, it, expect } from 'vitest';
import { channelGains } from './channelMixer.js';

describe('channelGains', () => {
  it('plays everything when nothing is muted or soloed', () => {
    expect(channelGains(3, new Set(), new Set())).toEqual([1, 1, 1]);
    expect(channelGains(2, null, null)).toEqual([1, 1]);
  });

  it('silences a muted channel', () => {
    expect(channelGains(3, new Set([1]), new Set())).toEqual([1, 0, 1]);
  });

  it('a solo plays only the soloed channels, whatever is muted', () => {
    expect(channelGains(3, new Set([0]), new Set([0]))).toEqual([1, 0, 0]);
    expect(channelGains(3, new Set(), new Set([1, 2]))).toEqual([0, 1, 1]);
  });
});
