import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mountDocumentHook, fakeDocument, fakeClient } from '@/test/mountDocumentHook.jsx';
import { fakeRaf } from '@/test/fakeRaf.js';
import { useMediaOperations } from './useMediaOperations.js';
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
  // Both, as the real operations object carries them: the ref for the media
  // tab's own imperative work, the state for everything that has to re-render
  // when the element arrives. The timeline must read the state.
  mediaElement: 'mediaElement' in over ? over.mediaElement : fakeMediaElement(),
  mediaElementRef: { current: over.mediaElement ?? null },
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
  <div ref={ops.attachTimelineContainer}>
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

  it('reads the element from the tab state, never from the ref beside it', async () => {
    const el = fakeMediaElement();
    const h = await mount(
      makeOps({ isPlaying: true, mediaElement: null, mediaElementRef: { current: el } }),
    );
    expect(raf.pending).toBe(0);
    await h.unmount();
  });
});

// The seam between the player and the timeline: the player mounts the element
// and the timeline draws from it. Both hooks run here, over one fake document
// with no recording on it, so nothing is fetched.
const usePlayerAndTimeline = (showElement) => {
  const mediaOps = useMediaOperations();
  const timelineOps = useTimelineOperations(mediaOps);
  return { showElement, mediaOps, timelineOps };
};

const playerAndLane = (api) => (
  <>
    {api.showElement && <video ref={api.mediaOps.setMediaElement} data-testid="player" />}
    {lane(api.timelineOps)}
  </>
);

const mountBoth = (showElement) =>
  mountDocumentHook(usePlayerAndTimeline, {
    doc: fakeDocument(),
    ctx: { client: fakeClient(), canWrite: true },
    args: [showElement],
    render: playerAndLane,
  });

describe('the timeline and the player', () => {
  it('the needle loop starts on the first frame after the element mounts', async () => {
    const h = await mountBoth(false);
    // Playback is already running when the element arrives, which is the case
    // a ref read during render can never see.
    await h.step(() => h.api.mediaOps.handlePlayingChange(true));
    expect(raf.pending).toBe(0);

    await h.setInputs({ args: [true] });

    // Nothing else was touched: mounting the element is the only thing that
    // has happened since.
    expect(raf.pending).toBe(1);
    const el = h.container.querySelector('[data-testid="player"]');
    el.currentTime = 4;
    await h.step(() => raf.pump());
    expect(needle(h)).toBe('100px');

    // And it goes again when the element does.
    await h.setInputs({ args: [false] });
    expect(raf.pending).toBe(0);
    await h.unmount();
  });

  it('a timeline click reaches the element on the commit that mounted it', async () => {
    // The element has to ARRIVE while the timeline is already on screen, and
    // the seek has to be the next thing that happens. Mounted from the first
    // render, and reached through the pointer, this was green under a full
    // revert of the fix it names: a mousedown is a state change, so the
    // re-render it causes fills a ref in before the mouseup seeks.
    const h = await mountBoth(false);
    // A recording with no duration has no positions to click on.
    await h.step(() => h.api.mediaOps.handleDurationChange(60));
    expect(h.container.querySelector('[data-testid="player"]')).toBeNull();

    await h.setInputs({ args: [true] });
    const el = h.container.querySelector('[data-testid="player"]');
    expect(el.currentTime).toBe(0);

    // Nothing has re-rendered since the commit that mounted it, which is the
    // state a ref read during render can never leave.
    await h.step(() => h.api.timelineOps.handleTimelineClick(3));
    expect(el.currentTime).toBe(3);

    // And through the pointer, which is how a reader gets there.
    await mouse(h, 'mousedown', 50);
    await mouse(h, 'mouseup', 50.5);
    // 25 px/s is the tab's starting zoom, so 50 px in is two seconds.
    expect(el.currentTime).toBe(2);
    await h.unmount();
  });
});

describe('useTimelineOperations: the wheel', () => {
  it('a scrolling box that mounts later still takes the wheel', async () => {
    let boxMounted = false;
    const ops = makeOps();
    const h = await mountDocumentHook(useTimelineOperations, {
      args: [ops],
      render: (api) => (
        <>
          {boxMounted && <div ref={api.attachTimelineContainer} data-testid="box" />}
          <div ref={api.timelineRef} data-testid="lane" />
        </>
      ),
    });

    boxMounted = true;
    // The SAME operations object, so nothing else about the hook has changed.
    // An effect keyed on anything but the box would not run again.
    await h.setInputs({ args: [ops] });

    const box = h.container.querySelector('[data-testid="box"]');
    // A bare wheel pans, by the distance the gesture reports.
    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
      deltaMode: 0,
    });
    box.dispatchEvent(wheel);

    expect(wheel.defaultPrevented).toBe(true);
    expect(box.scrollLeft).toBe(120);
    await h.unmount();
  });
});

describe('useTimelineOperations: resizing a segment', () => {
  const segment = { id: 'a-1', metadata: { timeBegin: 1, timeEnd: 2 } };
  const resizable = () => ({
    alignmentTokens: [segment],
    updateAlignmentBounds: vi.fn(async () => true),
  });
  const grab = () => ({ stopPropagation: vi.fn(), preventDefault: vi.fn() });
  const move = (clientX) =>
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX }));
  const release = () => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

  it('commits the bounds of its last move, across separate commits', async () => {
    const doc = resizable();
    const h = await mount(makeOps({ doc }));
    await h.step(() => h.api.handleResizeStart(grab(), segment, 'right'));
    expect(h.api.isResizing).toBe(true);

    await h.step(() => move(300));
    expect(h.api.tempTokenBounds).toEqual({ start: 1, end: 30 });
    await h.step(() => move(400));
    expect(h.api.tempTokenBounds).toEqual({ start: 1, end: 40 });
    await h.step(() => release());

    expect(doc.updateAlignmentBounds).toHaveBeenCalledWith('a-1', { timeBegin: 1, timeEnd: 40 });
    expect(h.api.isResizing).toBe(false);
    expect(h.api.tempTokenBounds).toBeNull();
    await h.unmount();
  });

  it('commits the last move even when the release lands in the same commit', async () => {
    const doc = resizable();
    const h = await mount(makeOps({ doc }));
    await h.step(() => h.api.handleResizeStart(grab(), segment, 'right'));

    // Both moves and the release before React commits anything: the release
    // must read what the second move worked out, not what it was created with.
    await h.step(() => {
      move(300);
      move(400);
      release();
    });

    expect(doc.updateAlignmentBounds).toHaveBeenCalledTimes(1);
    expect(doc.updateAlignmentBounds).toHaveBeenCalledWith('a-1', { timeBegin: 1, timeEnd: 40 });
    await h.unmount();
  });

  it('a second release writes nothing', async () => {
    const doc = resizable();
    const h = await mount(makeOps({ doc }));
    await h.step(() => h.api.handleResizeStart(grab(), segment, 'right'));
    await h.step(() => {
      move(400);
      release();
      release();
    });

    expect(doc.updateAlignmentBounds).toHaveBeenCalledTimes(1);
    await h.unmount();
  });

  it('the left handle moves the start and leaves the end', async () => {
    const doc = resizable();
    const h = await mount(makeOps({ doc }));
    await h.step(() => h.api.handleResizeStart(grab(), segment, 'left'));
    await h.step(() => move(5));
    await h.step(() => release());

    expect(doc.updateAlignmentBounds).toHaveBeenCalledWith('a-1', { timeBegin: 0.5, timeEnd: 2 });
    await h.unmount();
  });
});
