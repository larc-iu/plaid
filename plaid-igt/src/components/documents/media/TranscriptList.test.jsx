import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderComponent, all, texts } from '../../../test/renderComponent.jsx';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { TranscriptList } from './TranscriptList.jsx';

// The transcript rows against a fake document: what a row shows, what a
// keystroke writes, and where focus goes next. The real mutations are covered
// in mutations/alignment.js; here they are spies that succeed.

function makeDoc({ body, tokens }) {
  const listeners = new Set();
  return {
    body,
    isSaving: false,
    alignmentTokens: tokens,
    knownSpeakers: ['Ana'],
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSnapshot: () => 0,
    editAlignment: vi.fn(async () => true),
    updateAlignmentSpeaker: vi.fn(async () => true),
    createAlignment: vi.fn(async () => true),
  };
}

const makeOps = (over = {}) => ({
  currentTime: 0,
  isPlaying: false,
  playingSelection: null,
  selection: null,
  setSelection: vi.fn(),
  setPopoverOpened: vi.fn(),
  playRange: vi.fn(),
  pausePlayback: vi.fn(),
  togglePlayback: vi.fn(),
  autoPlayOnFocus: true,
  setAutoPlayOnFocus: vi.fn(),
  handleDeleteAlignment: vi.fn(),
  ...over,
});

// Out of time order on purpose: the list must sort.
const TOKENS = [
  { id: 'b', begin: 4, end: 7, metadata: { timeBegin: 1.5, timeEnd: 3 } },
  { id: 'a', begin: 0, end: 3, metadata: { timeBegin: 0, timeEnd: 1.5, speaker: 'Ana' } },
];

// Type into a controlled field the way a user does: through the native setter
// (past React's value tracker) and an input event.
const setValue = (el, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const press = (el, key, init = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
const settle = () => new Promise((r) => setTimeout(r, 0));

const element = (doc, ops, readOnly = false) => (
  <DocumentProvider value={{ doc, readOnly }}>
    <TranscriptList mediaOps={ops} readOnly={readOnly} />
  </DocumentProvider>
);

const rowTextareas = (root) => all(root, 'textarea[aria-label^="Segment"]');
const newTextarea = (root) => root.querySelector('textarea[aria-label="New segment text"]');

describe('TranscriptList', () => {
  it('lists segments in time order with millisecond times and the stored text', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const r = await renderComponent(element(doc, makeOps()));
    expect(rowTextareas(r.container).map((t) => t.value)).toEqual(['the', 'cat']);
    const times = all(r.container, 'input[aria-label$=" start"], input[aria-label$=" end"]').map(
      (i) => i.value,
    );
    expect(times).toEqual(['0:00.000', '0:01.500', '0:01.500', '0:03.000']);
    expect(all(r.container, 'input[aria-label="Segment 1 speaker"]')[0].value).toBe('Ana');
    expect(r.container.textContent).toContain('2 segments');
    await r.unmount();
  });

  it('moving into a row selects its stretch and plays it, unless play-on-focus is off', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const ops = makeOps();
    const r = await renderComponent(element(doc, ops));
    await r.step(() => rowTextareas(r.container)[1].focus());
    expect(ops.setPopoverOpened).toHaveBeenCalledWith(false);
    expect(ops.setSelection).toHaveBeenCalledWith({ start: 1.5, end: 3 });
    expect(ops.playRange).toHaveBeenCalledWith({ start: 1.5, end: 3 });
    await r.unmount();

    const quiet = makeOps({ autoPlayOnFocus: false });
    const r2 = await renderComponent(element(doc, quiet));
    await r2.step(() => rowTextareas(r2.container)[0].focus());
    expect(quiet.setSelection).toHaveBeenCalledWith({ start: 0, end: 1.5 });
    expect(quiet.playRange).not.toHaveBeenCalled();
    await r2.unmount();
  });

  it('Enter saves a changed row with its times and speaker, then moves to the next row', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const r = await renderComponent(element(doc, makeOps()));
    const [first, second] = rowTextareas(r.container);
    await r.step(() => first.focus());
    await r.step(() => setValue(first, 'thee'));
    await r.step(async () => {
      press(first, 'Enter');
      await settle();
    });
    expect(doc.editAlignment).toHaveBeenCalledTimes(1);
    expect(doc.editAlignment).toHaveBeenCalledWith('a', {
      text: 'thee',
      timeBegin: 0,
      timeEnd: 1.5,
      speaker: 'Ana',
    });
    expect(document.activeElement).toBe(second);
    await r.unmount();
  });

  it('Enter on the last row moves into the new-segment row', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const r = await renderComponent(element(doc, makeOps()));
    const last = rowTextareas(r.container)[1];
    await r.step(() => last.focus());
    await r.step(async () => {
      press(last, 'Enter');
      await settle();
    });
    expect(doc.editAlignment).not.toHaveBeenCalled(); // nothing changed, nothing written
    expect(document.activeElement).toBe(newTextarea(r.container));
    await r.unmount();
  });

  it('a speaker-only change relabels the segment without rewriting its text', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const r = await renderComponent(element(doc, makeOps()));
    const speaker = r.container.querySelector('input[aria-label="Segment 2 speaker"]');
    await r.step(() => setValue(speaker, 'Ben'));
    await r.step(async () => {
      press(speaker, 'Enter');
      await settle();
    });
    expect(doc.updateAlignmentSpeaker).toHaveBeenCalledWith('b', 'Ben');
    expect(doc.editAlignment).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(rowTextareas(r.container)[1]);
    await r.unmount();
  });

  it('Escape puts a row back, and an emptied row is put back rather than saved', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const r = await renderComponent(element(doc, makeOps()));
    const second = rowTextareas(r.container)[1];
    await r.step(() => setValue(second, 'dog'));
    expect(second.value).toBe('dog');
    await r.step(() => press(second, 'Escape'));
    expect(second.value).toBe('cat');

    await r.step(() => setValue(second, '   '));
    await r.step(async () => {
      press(second, 'Enter');
      await settle();
    });
    expect(doc.editAlignment).not.toHaveBeenCalled();
    expect(second.value).toBe('cat');
    await r.unmount();
  });

  it('the new-segment row waits for the playhead to pass the last segment, then creates from its end', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const r = await renderComponent(element(doc, makeOps({ currentTime: 1.0 })));
    expect(r.container.textContent).toContain('Playback must be past 0:03.000');
    const fresh = newTextarea(r.container);
    await r.step(() => setValue(fresh, 'dog'));
    await r.step(async () => {
      press(fresh, 'Enter');
      await settle();
    });
    expect(doc.createAlignment).not.toHaveBeenCalled();

    await r.rerender(element(doc, makeOps({ currentTime: 4.2 })));
    expect(r.container.textContent).toContain('0:03.000 to 0:04.200 (playback)');
    expect(fresh.value).toBe('dog');
    await r.step(async () => {
      press(fresh, 'Enter');
      await settle();
    });
    expect(doc.createAlignment).toHaveBeenCalledWith({
      text: 'dog',
      timeBegin: 3,
      timeEnd: 4.2,
      speaker: '',
    });
    expect(fresh.value).toBe('');
    await r.unmount();
  });

  it('with no segments the new-segment row starts at the beginning of the recording', async () => {
    const doc = makeDoc({ body: '', tokens: [] });
    const r = await renderComponent(element(doc, makeOps({ currentTime: 2.5 })));
    expect(r.container.textContent).toContain('No segments yet');
    expect(r.container.textContent).toContain('0:00.000 to 0:02.500 (playback)');
    await r.unmount();
  });

  describe('time fields', () => {
    const timeInput = (root, n, which) =>
      root.querySelector(`input[aria-label="Segment ${n} ${which}"]`);
    const withBounds = () => {
      const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
      doc.updateAlignmentBounds = vi.fn(async () => true);
      return doc;
    };

    it('shows the boundaries as editable times and saves a typed one', async () => {
      const doc = withBounds();
      const r = await renderComponent(element(doc, makeOps({ duration: 10 })));
      const end = timeInput(r.container, 2, 'end');
      expect(end.value).toBe('0:03.000');
      await r.step(() => end.focus());
      await r.step(() => setValue(end, '0:02.500'));
      await r.step(async () => {
        press(end, 'Enter');
        await settle();
      });
      expect(doc.updateAlignmentBounds).toHaveBeenCalledWith('b', { timeBegin: 1.5, timeEnd: 2.5 });
      expect(document.activeElement).toBe(end); // Enter keeps focus, so a nudge can follow
      await r.unmount();
    });

    it('Up and Down nudge by 10 ms, with Shift by 100 ms, and blur saves', async () => {
      const doc = withBounds();
      const r = await renderComponent(element(doc, makeOps({ duration: 10 })));
      const end = timeInput(r.container, 2, 'end');
      await r.step(() => end.focus());
      await r.step(() => press(end, 'ArrowUp'));
      expect(end.value).toBe('0:03.010');
      await r.step(() => press(end, 'ArrowDown', { shiftKey: true }));
      expect(end.value).toBe('0:02.910');
      await r.step(async () => {
        end.blur();
        await settle();
      });
      expect(doc.updateAlignmentBounds).toHaveBeenCalledWith('b', {
        timeBegin: 1.5,
        timeEnd: 2.91,
      });
      await r.unmount();
    });

    it('Escape puts a time back, and text that is not a time is refused', async () => {
      const doc = withBounds();
      const r = await renderComponent(element(doc, makeOps({ duration: 10 })));
      const begin = timeInput(r.container, 2, 'start');
      await r.step(() => setValue(begin, '0:01.000'));
      await r.step(() => press(begin, 'Escape'));
      expect(begin.value).toBe('0:01.500');
      await r.step(() => setValue(begin, 'soon'));
      await r.step(async () => {
        press(begin, 'Enter');
        await settle();
      });
      expect(doc.updateAlignmentBounds).not.toHaveBeenCalled();
      expect(begin.value).toBe('0:01.500');
      await r.unmount();
    });

    it('refuses a boundary that runs into a neighbour, past the recording, or past its own other end', async () => {
      const doc = withBounds();
      const r = await renderComponent(element(doc, makeOps({ duration: 4 })));
      const tryValue = async (field, value) => {
        await r.step(() => setValue(field, value));
        await r.step(async () => {
          press(field, 'Enter');
          await settle();
        });
      };
      await tryValue(timeInput(r.container, 2, 'start'), '0:01.000'); // before the first ends (1.5)
      await tryValue(timeInput(r.container, 1, 'end'), '0:02.000'); // into the second (starts 1.5)
      await tryValue(timeInput(r.container, 2, 'end'), '0:05.000'); // past a 4 s recording
      await tryValue(timeInput(r.container, 2, 'end'), '0:01.500'); // no length left
      expect(doc.updateAlignmentBounds).not.toHaveBeenCalled();
      expect(timeInput(r.container, 2, 'start').value).toBe('0:01.500');
      expect(timeInput(r.container, 1, 'end').value).toBe('0:01.500');
      await r.unmount();
    });
  });

  it('read-only shows the transcript with play buttons but no inputs and no new-segment row', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const r = await renderComponent(element(doc, makeOps(), true));
    expect(all(r.container, 'textarea')).toHaveLength(0);
    expect(all(r.container, 'input')).toHaveLength(0);
    expect(texts(r.container, '[data-segment-id] p')).toEqual(['the', 'cat']);
    expect(all(r.container, 'button[aria-label="Play segment"]')).toHaveLength(2);
    expect(all(r.container, 'button[aria-label="Delete segment"]')).toHaveLength(0);
    await r.unmount();
  });

  it('a machine-made segment says so', async () => {
    const tokens = [
      { id: 'm', begin: 0, end: 3, metadata: { timeBegin: 0, timeEnd: 1, prov: 'inferred' } },
    ];
    const doc = makeDoc({ body: 'the', tokens });
    const r = await renderComponent(element(doc, makeOps()));
    expect(r.container.textContent).toContain('machine');
    await r.unmount();
  });
});
