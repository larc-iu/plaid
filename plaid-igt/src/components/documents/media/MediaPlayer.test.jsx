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

const mediaOps = (over = {}) => ({
  authenticatedMediaUrl: 'blob:rec',
  mediaReady: true,
  handleMediaLoaded: vi.fn(),
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
  ...over,
});

const named = (error, name) => Object.assign(error, { name });

const mountWith = async (rejection) => {
  const view = await renderComponent(<MediaPlayer mediaOps={mediaOps()} canWrite />);
  const element = view.container.querySelector('video');
  await view.step(() => element.dispatchEvent(new Event('loadedmetadata')));
  element.play = vi.fn(() => Promise.reject(rejection));
  element.pause = vi.fn();
  const play = all(view.container, 'button').find((b) => b.getAttribute('aria-label') === 'Play');
  await view.step(async () => {
    play.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return view;
};

const banner = (container) => (container.textContent.includes('Playback error') ? 'shown' : 'none');

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
    expect(view.container.textContent).toContain('This browser cannot play this format.');
    await view.unmount();
  });
});

// The recording arrives as a whole file after the tab opens, and a skip or a
// seek made before the element has it moved nothing: the playhead stayed at
// 0:00.000 once the file had loaded. The transport waits for the file.
describe('the transport before the recording has loaded', () => {
  const TRANSPORT = [
    'Skip to beginning',
    'Skip back 5 seconds',
    'Play',
    'Skip forward 5 seconds',
    'Skip to end',
  ];
  const states = (container) =>
    TRANSPORT.map((label) => {
      const b = all(container, 'button').find((x) => x.getAttribute('aria-label') === label);
      return `${label}: ${b.disabled ? 'off' : 'on'}`;
    });
  const seekOff = (container) =>
    container.querySelectorAll('[role="slider"]')[0].hasAttribute('data-disabled');

  it('is off until the element has the file, then on', async () => {
    const view = await renderComponent(
      <MediaPlayer mediaOps={mediaOps({ mediaReady: false })} canWrite />,
    );
    expect(states(view.container)).toEqual(TRANSPORT.map((l) => `${l}: off`));
    expect(seekOff(view.container)).toBe(true);
    await view.rerender(<MediaPlayer mediaOps={mediaOps({ mediaReady: true })} canWrite />);
    expect(states(view.container)).toEqual(TRANSPORT.map((l) => `${l}: on`));
    expect(seekOff(view.container)).toBe(false);
    await view.unmount();
  });

  // Which file has loaded is the hook's to keep (it gates the keys and the
  // transcript rows too). The player tells it, naming the file.
  it('tells the tab which file the element has read', async () => {
    const ops = mediaOps({ mediaReady: false });
    const view = await renderComponent(<MediaPlayer mediaOps={ops} canWrite />);
    const element = view.container.querySelector('video');
    await view.step(() => element.dispatchEvent(new Event('loadedmetadata')));
    expect(ops.handleMediaLoaded.mock.calls).toEqual([['blob:rec']]);
    await view.unmount();
  });
});
