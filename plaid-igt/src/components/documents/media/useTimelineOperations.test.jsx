import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mountDocumentHook } from '@/test/mountDocumentHook.jsx';
import { fakeRaf } from '@/test/fakeRaf.js';
import { useTimelineOperations } from './useTimelineOperations.js';

// The timeline's two moving parts: the needle, drawn frame by frame off the
// recording's own clock, and the drag that makes a selection.
//
// Both are invisible to a test that reads the end state. The needle's loop
// reschedules itself, so the last frame always wins and a frame drawn from the
// wrong clock is painted over; the drag keeps its origin in React state, so a
// second gesture could carry the first one's start. What is asserted here is
// the sequence of needle positions the timeline actually SHOWED, and what each
// gesture did with the pointer it was handed.
//
// One `step` per event, because that is what a browser does: mousedown and
// mouseup are discrete, and React commits between them. Two events inside one
// `act` commit nothing until the act ends, which is a state the real timeline
// is never in.

let raf;
beforeEach(() => {
  raf = fakeRaf().install();
});
afterEach(() => vi.unstubAllGlobals());

// A recording the hook can read a clock off and seek.
const fakeMediaElement = (over = {}) => ({ currentTime: 0, duration: 60, ...over });

// The media tab's operations object, as the timeline sees it. A fresh one per
// render in the app, so nothing here may depend on its identity.
const makeOps = (over = {}) => ({
  doc: { alignmentTokens: over.alignmentTokens ?? [] },
  mediaElementRef: { current: over.mediaElement ?? fakeMediaElement() },
  duration: 60,
  pixelsPerSecond: 10,
  currentTime: 0,
  isPlaying: false,
  selection: null,
  popoverOpened: false,
  mediaBlob: null,
  setCurrentTime: vi.fn(),
  setPlayingSelection: vi.fn(),
  setSelection: vi.fn(),
  setPopoverOpened: vi.fn(),
  setPixelsPerSecond: vi.fn(),
  ...over,
});

// The bit of the Timeline the hook needs to exist: a scrolling box, the lane
// that takes the pointer, and the needle it moves.
const lane = (ops) => (
  <div ref={ops.timelineContainerRef}>
    <div
      ref={ops.timelineRef}
      data-testid="lane"
      onMouseDown={ops.handleMouseDown}
      onMouseMove={ops.handleMouseMove}
      onMouseUp={ops.handleMouseUp}
    >
      <div ref={ops.needleRef} data-testid="needle" />
    </div>
  </div>
);

const needle = (h) => h.container.querySelector('[data-testid="needle"]').style.left;

// One pointer event, committed before the next one is sent. `clientX` is a
// pixel on the lane, which starts at 0 in this environment, so at 10 px/s a
// clientX of 50 is five seconds in.
const mouse = (h, type, clientX) =>
  h.step(() =>
    h.container
      .querySelector('[data-testid="lane"]')
      .dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX })),
  );

const mount = (ops, extra = {}) =>
  mountDocumentHook(useTimelineOperations, { args: [ops], render: lane, ...extra });

describe('useTimelineOperations: the needle loop', () => {
  it('a click during playback lands the needle where the pointer was', async () => {
    const media = fakeMediaElement();
    const ops = makeOps({ isPlaying: true, mediaElement: media });
    const h = await mount(ops);

    const shown = [];
    await h.step(() => raf.pump());
    shown.push(needle(h));

    // A press and a release within a tenth of a second of each other is a
    // click, not a drag: it seeks rather than selecting.
    await mouse(h, 'mousedown', 50);
    await mouse(h, 'mouseup', 50.5);
    expect(media.currentTime).toBe(5);
    expect(ops.setSelection).not.toHaveBeenCalled();

    await h.step(() => raf.pump());
    shown.push(needle(h));

    expect(shown).toEqual(['0px', '50px']);
    await h.unmount();
  });

  it('a drag makes a selection and leaves playback where it was', async () => {
    const media = fakeMediaElement({ currentTime: 2 });
    const ops = makeOps({ isPlaying: true, mediaElement: media });
    const h = await mount(ops);

    await h.step(() => raf.pump());
    expect(needle(h)).toBe('20px');

    await mouse(h, 'mousedown', 50);
    await mouse(h, 'mousemove', 200);
    await mouse(h, 'mouseup', 200);
    expect(ops.setSelection).toHaveBeenCalledWith({ start: 5, end: 20 });
    expect(ops.setPopoverOpened).toHaveBeenLastCalledWith(true);
    expect(media.currentTime).toBe(2);

    await h.step(() => raf.pump());
    expect(needle(h)).toBe('20px');
    await h.unmount();
  });

  it('a second drag started before the first frame lands uses its own origin', async () => {
    const ops = makeOps({ isPlaying: true });
    const h = await mount(ops);

    // No pump between the two gestures: nothing has been drawn since the
    // first one, which is exactly when an origin kept in state could be stale.
    await mouse(h, 'mousedown', 50);
    await mouse(h, 'mousemove', 200);
    await mouse(h, 'mouseup', 200);
    expect(ops.setSelection).toHaveBeenLastCalledWith({ start: 5, end: 20 });

    await mouse(h, 'mousedown', 300);
    await mouse(h, 'mousemove', 320);
    expect(h.api.tempSelection).toEqual({ start: 30, end: 32 });

    await mouse(h, 'mouseup', 320);
    expect(ops.setSelection).toHaveBeenLastCalledWith({ start: 30, end: 32 });
    expect(raf.pending).toBe(1);
    await h.unmount();
  });

  it('unmounting cancels the frame it had scheduled', async () => {
    const h = await mount(makeOps({ isPlaying: true }));
    expect(raf.pending).toBe(1);

    // The loop reschedules itself, so there is always exactly one outstanding.
    await h.step(() => raf.pump());
    expect(raf.pending).toBe(1);

    await h.unmount();
    expect(raf.pending).toBe(0);
    expect(raf.pump()).toBe(0);
  });

  it('pausing cancels the frame, and playing again starts a new loop', async () => {
    const h = await mount(makeOps({ isPlaying: true }));
    expect(raf.pending).toBe(1);

    await h.setInputs({ args: [makeOps({ isPlaying: false })] });
    expect(raf.pending).toBe(0);

    await h.setInputs({ args: [makeOps({ isPlaying: true })] });
    expect(raf.pending).toBe(1);
    await h.unmount();
    expect(raf.pending).toBe(0);
  });

  it('draws no needle while the recording is paused', async () => {
    const h = await mount(
      makeOps({ isPlaying: false, mediaElement: fakeMediaElement({ currentTime: 3 }) }),
    );
    expect(raf.pending).toBe(0);
    expect(needle(h)).toBe('');
    await h.unmount();
  });
});
