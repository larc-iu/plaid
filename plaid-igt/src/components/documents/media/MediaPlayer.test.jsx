import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// The one awaited `play()` on this tab. Two of the three ways it rejects say
// nothing about the file: an AbortError is a seek or a pause landing on top of
// the play, and a NotAllowedError is the browser's autoplay policy. Reported as
// a codec, they raised a banner that nothing takes down, over a recording that
// goes on playing.

vi.mock('./VadDetection.jsx', () => ({ VadDetection: () => null }));
vi.mock('./MediaHelp.jsx', () => ({ MediaHelp: () => null, MediaHelpButton: () => null }));

const { MediaPlayer } = await import('./MediaPlayer.jsx');

const mediaOps = () => ({
  authenticatedMediaUrl: 'blob:rec',
  isLoadingMedia: false,
  mediaLoadError: null,
  mediaBlob: {},
  currentTime: 0,
  duration: 10,
  isPlaying: false,
  volume: 0.8,
  playbackRate: 1,
  loopSegment: false,
  setLoopSegment: vi.fn(),
  handleTimeUpdate: vi.fn(),
  handleDurationChange: vi.fn(),
  handlePlayingChange: vi.fn(),
  handleVolumeChange: vi.fn(),
  handleSkipToBeginning: vi.fn(),
  handleSkipToEnd: vi.fn(),
  setMediaElement: vi.fn(),
  handleSeek: vi.fn(),
  handleDeleteMedia: vi.fn(),
  handlePlaybackRateChange: vi.fn(),
});

const named = (error, name) => Object.assign(error, { name });

const mountWith = async (rejection) => {
  const view = await renderComponent(<MediaPlayer mediaOps={mediaOps()} canWrite />);
  const element = view.container.querySelector('video');
  element.play = vi.fn(() => Promise.reject(rejection));
  element.pause = vi.fn();
  const play = all(view.container, 'button').find((b) => b.getAttribute('aria-label') === 'Play');
  await view.step(async () => {
    play.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return view;
};

const banner = (container) => (container.textContent.includes('Playback Error') ? 'shown' : 'none');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a play() the browser refuses', () => {
  it('says nothing when a seek or a pause aborted it', async () => {
    const view = await mountWith(
      named(new Error('The play() request was interrupted'), 'AbortError'),
    );
    expect(banner(view.container)).toBe('none');
    await view.unmount();
  });

  it('says nothing when the autoplay policy refused it', async () => {
    const view = await mountWith(
      named(new Error('play() failed because the user did not interact'), 'NotAllowedError'),
    );
    expect(banner(view.container)).toBe('none');
    await view.unmount();
  });

  it('still names an unplayable file', async () => {
    const view = await mountWith(named(new Error('no supported source'), 'NotSupportedError'));
    expect(banner(view.container)).toBe('shown');
    expect(view.container.textContent).toContain('Media format not supported');
    await view.unmount();
  });
});
