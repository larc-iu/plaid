import { describe, it, expect } from 'vitest';
import { bareMediaType, extensionForMediaType, mediaTypeForName } from './mediaTypes.js';

// The archive exporter and the ELAN exporter held the same table twice,
// inverted, and had drifted: only the archive one knew the audio/vnd.wave the
// core serves for a .wav upload, and audio/x-flac.

describe('media types and extensions', () => {
  it('reads a recording’s type off its name', () => {
    expect(mediaTypeForName('story.wav')).toBe('audio/x-wav');
    expect(mediaTypeForName('story.MP3')).toBe('audio/mpeg');
    expect(mediaTypeForName('clip.mov')).toBe('video/quicktime');
  });

  it('falls back for a name the table does not know', () => {
    expect(mediaTypeForName('story.xyz')).toBe('audio/x-wav');
    expect(mediaTypeForName(null)).toBe('audio/x-wav');
    expect(mediaTypeForName('story.xyz', 'audio/ogg')).toBe('audio/ogg');
  });

  it('knows every spelling of a type both exporters may meet', () => {
    for (const t of ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']) {
      expect(extensionForMediaType(t)).toBe('.wav');
    }
    expect(extensionForMediaType('audio/flac')).toBe('.flac');
    expect(extensionForMediaType('audio/x-flac')).toBe('.flac');
  });

  it('ignores the parameters on a Content-Type header', () => {
    expect(extensionForMediaType('audio/mpeg; charset=binary')).toBe('.mp3');
    expect(bareMediaType(' Audio/MPEG ;q=1 ')).toBe('audio/mpeg');
  });

  it('reads a plausible extension out of a type it does not know', () => {
    expect(extensionForMediaType('audio/x-caf')).toBe('.caf');
    expect(extensionForMediaType('application/octet-stream')).toBe('');
    expect(extensionForMediaType(null)).toBe('');
  });

  it('round-trips every canonical pair', () => {
    for (const ext of ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac', 'weba', 'mp4', 'webm', 'mov']) {
      expect(extensionForMediaType(mediaTypeForName(`a.${ext}`))).toBe(`.${ext}`);
    }
  });
});
