// Text typed into the transcript and then left (H7-1). The new-segment row is
// saved only by Enter, so its text is a draft: every way out asks first, as
// Baseline's edit box does. A row, a proposal and a time box save when focus
// leaves them, as an Analyze cell does: a tab or link click saves them through
// that blur and asks nothing, the transcript going away (the browser's Back)
// saves them too, and a reload, which cannot wait for a save, asks.
import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { hasUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { TranscriptList } from './TranscriptList.jsx';
import { settle } from '@/domain/test-helpers.js';

function makeDoc() {
  return {
    body: 'the cat',
    isSaving: false,
    alignmentTokens: [
      { id: 'a', begin: 0, end: 3, metadata: { timeBegin: 0, timeEnd: 1.5 } },
      { id: 'b', begin: 4, end: 7, metadata: { timeBegin: 1.5, timeEnd: 3 } },
    ],
    knownSpeakers: [],
    subscribe: () => () => {},
    getSnapshot: () => 0,
    cellWrite: (fn) => Promise.resolve(fn()).then((value) => ({ landed: true, value })),
    editAlignment: vi.fn(async () => true),
    updateAlignmentSpeaker: vi.fn(async () => true),
    updateAlignmentBounds: vi.fn(async () => true),
    createAlignment: vi.fn(async () => true),
    segmentDeleteLoss: vi.fn(() => ({
      annotations: 0,
      links: 0,
      shortened: { annotations: 0, links: 0 },
    })),
  };
}

const makeOps = (over = {}) => ({
  mediaReady: true,
  currentTime: 5,
  duration: 10,
  getCurrentTime: () => null,
  segmentFocusRequest: null,
  isPlaying: false,
  playingNow: () => false,
  playingSelection: null,
  selection: null,
  setSelection: vi.fn(),
  setPopoverOpened: vi.fn(),
  playRange: vi.fn(),
  playRangeFromHere: vi.fn(),
  pausePlayback: vi.fn(),
  togglePlayback: vi.fn(),
  autoPlayOnFocus: false,
  setAutoPlayOnFocus: vi.fn(),
  handleDeleteAlignment: vi.fn(),
  playbackRate: 1,
  handlePlaybackRateChange: vi.fn(),
  vad: { proposals: [{ id: 'vad-1', timeBegin: 4, timeEnd: 4.8 }], dismiss: vi.fn() },
  ...over,
});

const element = (doc, ops, readOnly = false) => (
  <DocumentProvider value={{ doc, readOnly }}>
    <TranscriptList mediaOps={ops} readOnly={readOnly} />
  </DocumentProvider>
);

const setValue = (el, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

// What a reload or a closed window does first: true when the page asked.
const reloadAsks = () => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

const q = (root, sel) => root.querySelector(sel);
const NEW_TEXT = 'textarea[aria-label="New segment text"]';
const ROW_TEXT = 'textarea[aria-label="Segment 1 text"]';
const ROW_SPEAKER = 'input[aria-label="Segment 1 speaker"]';
const PROPOSAL_TEXT = '[data-vad-proposal-row="vad-1"] textarea';
const END_MS = 'input[aria-label="Segment 2 end milliseconds"]';

describe('leaving the transcript with something typed', () => {
  it('the new-segment row asks on every way out while it holds text, and stops once it is saved', async () => {
    const doc = makeDoc();
    const r = await renderComponent(element(doc, makeOps()));
    expect(hasUnsavedDraft()).toBe(null);
    const box = q(r.container, NEW_TEXT);
    await r.step(() => box.focus());
    await r.step(() => setValue(box, 'bisa nan'));
    expect(hasUnsavedDraft()).toBe('The new segment you have typed');
    await r.step(() => setValue(box, '   '));
    expect(hasUnsavedDraft()).toBe(null);
    await r.step(() => setValue(box, 'bisa nan'));
    await r.step(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
    });
    expect(doc.createAlignment).toHaveBeenCalledTimes(1);
    expect(hasUnsavedDraft()).toBe(null);
    await r.unmount();
  });

  it('a row typed into asks nothing of a tab or a link, is saved when the transcript goes away, and a reload asks', async () => {
    const doc = makeDoc();
    const r = await renderComponent(element(doc, makeOps()));
    const box = q(r.container, ROW_TEXT);
    await r.step(() => box.focus());
    await r.step(() => setValue(box, 'thee'));
    // The tab strip and links ask through the drafts. This row is saved by
    // the blur their click causes, so it is not one.
    expect(hasUnsavedDraft()).toBe(null);
    expect(reloadAsks()).toBe(true);
    await r.unmount();
    await settle();
    expect(doc.editAlignment).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ text: 'thee', timeBegin: 0, timeEnd: 1.5 }),
    );
    expect(reloadAsks()).toBe(false);
  });

  it("a row's speaker typed into is saved when the transcript goes away", async () => {
    const doc = makeDoc();
    const r = await renderComponent(element(doc, makeOps()));
    const box = q(r.container, ROW_SPEAKER);
    await r.step(() => box.focus());
    await r.step(() => setValue(box, 'Ana'));
    expect(reloadAsks()).toBe(true);
    await r.unmount();
    await settle();
    expect(doc.updateAlignmentSpeaker).toHaveBeenCalledWith('a', 'Ana');
  });

  it('a proposal typed into is saved when the transcript goes away, and a reload asks first', async () => {
    const doc = makeDoc();
    const r = await renderComponent(element(doc, makeOps()));
    const box = q(r.container, PROPOSAL_TEXT);
    await r.step(() => box.focus());
    await r.step(() => setValue(box, 'three'));
    expect(hasUnsavedDraft()).toBe(null);
    expect(reloadAsks()).toBe(true);
    await r.unmount();
    await settle();
    expect(doc.createAlignment).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'three', timeBegin: 4, timeEnd: 4.8 }),
    );
    expect(reloadAsks()).toBe(false);
  });

  it('a time typed into a box is saved when the transcript goes away, and a reload asks first', async () => {
    const doc = makeDoc();
    const r = await renderComponent(element(doc, makeOps()));
    const ms = q(r.container, END_MS);
    await r.step(() => ms.focus());
    await r.step(() => setValue(ms, '500'));
    expect(hasUnsavedDraft()).toBe(null);
    expect(reloadAsks()).toBe(true);
    await r.unmount();
    await settle();
    expect(doc.updateAlignmentBounds).toHaveBeenCalledWith('b', { timeBegin: 1.5, timeEnd: 3.5 });
    expect(reloadAsks()).toBe(false);
  });

  it('nothing typed, or a reader, asks nothing and saves nothing', async () => {
    for (const readOnly of [false, true]) {
      const doc = makeDoc();
      const r = await renderComponent(element(doc, makeOps(), readOnly));
      expect(hasUnsavedDraft()).toBe(null);
      expect(reloadAsks()).toBe(false);
      await r.unmount();
      await settle();
      expect(doc.editAlignment).not.toHaveBeenCalled();
      expect(doc.createAlignment).not.toHaveBeenCalled();
      expect(doc.updateAlignmentBounds).not.toHaveBeenCalled();
    }
  });
});
