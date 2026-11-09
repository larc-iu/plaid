import { describe, it, expect, vi, afterEach } from 'vitest';
import { channelGains, createChannelMixer } from './channelMixer.js';

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

// A Web Audio stand-in that records where each node's output goes.
const fakeAudio = () => {
  const node = (kind) => ({
    kind,
    out: [],
    connect(to) {
      this.out.push(to);
    },
    disconnect() {
      this.out = [];
    },
  });
  const made = { source: null };
  class Ctx {
    constructor() {
      this.state = 'running';
      this.destination = node('destination');
    }
    createMediaElementSource() {
      made.source = node('source');
      return made.source;
    }
    createChannelSplitter() {
      return node('splitter');
    }
    createChannelMerger() {
      return node('merger');
    }
    createGain() {
      return { ...node('gain'), gain: { value: 1 } };
    }
    close() {
      return Promise.resolve();
    }
  }
  return { Ctx, made };
};

describe('createChannelMixer', () => {
  afterEach(() => vi.unstubAllGlobals());
  const element = () => ({ paused: true, addEventListener() {}, removeEventListener() {} });

  it('plain() sends the element straight to the output, and attach() splits it again', () => {
    const { Ctx, made } = fakeAudio();
    vi.stubGlobal('window', { AudioContext: Ctx });
    const mixer = createChannelMixer();
    const el = element();
    mixer.attach(el, 2);
    expect(made.source.out.map((n) => n.kind)).toEqual(['splitter']);
    mixer.plain();
    expect(made.source.out.map((n) => n.kind)).toEqual(['destination']);
    expect(mixer.channelCount).toBe(0);
    mixer.attach(el, 2);
    expect(made.source.out.map((n) => n.kind)).toEqual(['splitter']);
    expect(mixer.channelCount).toBe(2);
  });
});
