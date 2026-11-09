import { describe, it, expect } from 'vitest';
import {
  CHANNEL_SPEAKERS_KEY,
  channelLabel,
  readChannelSpeakers,
  withChannelSpeaker,
} from './channelSpeakers.js';

describe('channelSpeakers', () => {
  it('reads the stored list, trimmed, and nothing from a document without one', () => {
    expect(readChannelSpeakers({ [CHANNEL_SPEAKERS_KEY]: [' Ana', 'Ben', ''] })).toEqual([
      'Ana',
      'Ben',
      '',
    ]);
    expect(readChannelSpeakers({})).toBeNull();
    expect(readChannelSpeakers(null)).toBeNull();
    // Two channels are not two speakers unless the list says so.
    expect(readChannelSpeakers({ [CHANNEL_SPEAKERS_KEY]: 'Ana' })).toBeNull();
    expect(readChannelSpeakers({ [CHANNEL_SPEAKERS_KEY]: [3, null, 'Cy'] })).toEqual([
      '',
      '',
      'Cy',
    ]);
  });

  it('sets one channel and sizes the list to the recording', () => {
    expect(withChannelSpeaker(null, 1, ' Ben ', 2)).toEqual(['', 'Ben']);
    expect(withChannelSpeaker(['Ana'], 2, 'Cy', 3)).toEqual(['Ana', '', 'Cy']);
    expect(withChannelSpeaker(['Ana', 'Ben', 'Cy'], 0, '', 2)).toEqual(['', 'Ben', 'Cy']);
  });

  it('names a channel by its speaker, else its number', () => {
    expect(channelLabel(0, ['Ana', ''])).toBe('Ana');
    expect(channelLabel(1, ['Ana', ''])).toBe('Channel 2');
    expect(channelLabel(0, null)).toBe('Channel 1');
  });
});
