import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderComponent, all, texts } from '@ui/test/renderComponent.jsx';
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
    updateAlignmentBounds: vi.fn(async () => true),
    createAlignment: vi.fn(async () => true),
  };
}

const makeOps = (over = {}) => ({
  currentTime: 0,
  duration: 10,
  getCurrentTime: () => null,
  segmentFocusRequest: null,
  isPlaying: false,
  playingSelection: null,
  selection: null,
  setSelection: vi.fn(),
  setPopoverOpened: vi.fn(),
  playRange: vi.fn(),
  playRangeFromHere: vi.fn(),
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
const press = (el, key, init = {}) => {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
};
const settle = () => new Promise((r) => setTimeout(r, 0));
// React's onBlur listens for `focusout` at the root, not the non-bubbling
// `blur`, so this is what moving focus away looks like to a component.
const blur = (el) => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

const element = (doc, ops, readOnly = false) => (
  <DocumentProvider value={{ doc, readOnly }}>
    <TranscriptList mediaOps={ops} readOnly={readOnly} />
  </DocumentProvider>
);

const rowTextareas = (root) => all(root, 'textarea[aria-label^="Segment"]');
const newTextarea = (root) => root.querySelector('textarea[aria-label="New segment text"]');
const timeGroup = (root, n, which) =>
  root.querySelector(`[role="group"][aria-label="Segment ${n} ${which}"]`);
const timeBox = (root, n, which, unit) =>
  root.querySelector(`input[aria-label="Segment ${n} ${which} ${unit}"]`);

describe('TranscriptList', () => {
  it('lists segments in time order with millisecond times and the stored text', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const r = await renderComponent(element(doc, makeOps()));
    expect(rowTextareas(r.container).map((t) => t.value)).toEqual(['the', 'cat']);
    const times = all(r.container, '[role="group"][data-value]').map((g) => g.dataset.value);
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

  it('a timeline click on a segment lands in its row with the caret at the end, and plays it', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const ops = makeOps();
    const r = await renderComponent(element(doc, ops));
    await r.rerender(element(doc, makeOps({ segmentFocusRequest: { id: 'b', at: 1 } })));
    const second = rowTextareas(r.container)[1];
    expect(document.activeElement).toBe(second);
    expect(second.selectionStart).toBe(second.value.length);
    await r.unmount();
  });

  it('Shift+Space in a row plays on within its segment (never from its start), and Ctrl+Space no longer does', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const ops = makeOps({ autoPlayOnFocus: false });
    const r = await renderComponent(element(doc, ops));
    const second = rowTextareas(r.container)[1];
    await r.step(() => second.focus());
    const shifted = press(second, ' ', { code: 'Space', shiftKey: true });
    expect(shifted.defaultPrevented).toBe(true);
    // The resume-or-restart operation, not the seek-to-start one that
    // play-on-entry uses.
    expect(ops.playRangeFromHere).toHaveBeenCalledWith({ start: 1.5, end: 3 });
    expect(ops.playRange).not.toHaveBeenCalled();
    const ctrl = press(second, ' ', { code: 'Space', ctrlKey: true });
    expect(ctrl.defaultPrevented).toBe(false);
    expect(ops.playRangeFromHere).toHaveBeenCalledTimes(1);
    await r.unmount();
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

  it('Down moves to the next row and Up to the previous, from the ends of the text', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const r = await renderComponent(element(doc, makeOps()));
    const [first, second] = rowTextareas(r.container);
    await r.step(() => {
      first.focus();
      first.setSelectionRange(first.value.length, first.value.length);
    });
    await r.step(async () => {
      press(first, 'ArrowDown');
      await settle();
    });
    expect(document.activeElement).toBe(second);

    await r.step(() => second.setSelectionRange(0, 0));
    await r.step(async () => {
      press(second, 'ArrowUp');
      await settle();
    });
    expect(document.activeElement).toBe(first);
    // Navigating changed nothing, so nothing was written.
    expect(doc.editAlignment).not.toHaveBeenCalled();
    await r.unmount();
  });

  it('leaves the arrows to the caret when it is not at the edge it would leave by', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const r = await renderComponent(element(doc, makeOps()));
    const [first, second] = rowTextareas(r.container);
    await r.step(() => {
      first.focus();
      first.setSelectionRange(1, 1); // mid-text: Down belongs to the box
    });
    await r.step(async () => {
      press(first, 'ArrowDown');
      await settle();
    });
    expect(document.activeElement).toBe(first);

    // A held modifier is a seek chord, not a step.
    await r.step(() => first.setSelectionRange(first.value.length, first.value.length));
    await r.step(async () => {
      press(first, 'ArrowDown', { shiftKey: true });
      await settle();
    });
    expect(document.activeElement).toBe(first);
    expect(second).toBeTruthy();
    await r.unmount();
  });

  it('Down from the last row reaches the new-segment row, and Up comes back', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const r = await renderComponent(element(doc, makeOps()));
    const last = rowTextareas(r.container)[1];
    await r.step(() => {
      last.focus();
      last.setSelectionRange(last.value.length, last.value.length);
    });
    await r.step(async () => {
      press(last, 'ArrowDown');
      await settle();
    });
    const fresh = newTextarea(r.container);
    expect(document.activeElement).toBe(fresh);

    await r.step(() => fresh.setSelectionRange(0, 0));
    await r.step(async () => {
      press(fresh, 'ArrowUp');
      await settle();
    });
    expect(document.activeElement).toBe(rowTextareas(r.container)[1]);
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

  it('the new-segment row waits for playback to pass the last segment, then creates from its end', async () => {
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

  it("the new segment ends at the recording's own clock, which may be ahead of the displayed one", async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const ops = makeOps({ currentTime: 4.2, getCurrentTime: () => 4.37 });
    const r = await renderComponent(element(doc, ops));
    const fresh = newTextarea(r.container);
    await r.step(() => setValue(fresh, 'dog'));
    await r.step(async () => {
      press(fresh, 'Enter');
      await settle();
    });
    expect(doc.createAlignment).toHaveBeenCalledWith({
      text: 'dog',
      timeBegin: 3,
      timeEnd: 4.37,
      speaker: '',
    });
    await r.unmount();
  });

  it('with no segments the new-segment row starts at the beginning of the recording', async () => {
    const doc = makeDoc({ body: '', tokens: [] });
    const r = await renderComponent(element(doc, makeOps({ currentTime: 2.5 })));
    expect(r.container.textContent).toContain('No segments yet');
    expect(r.container.textContent).toContain('0:00.000 to 0:02.500 (playback)');
    await r.unmount();
  });

  describe('segment times', () => {
    it('typing into the milliseconds box and pressing Enter saves the boundary in place', async () => {
      const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
      const r = await renderComponent(element(doc, makeOps()));
      const ms = timeBox(r.container, 2, 'end', 'milliseconds');
      await r.step(() => ms.focus());
      await r.step(() => setValue(ms, '500'));
      expect(timeGroup(r.container, 2, 'end').dataset.value).toBe('0:03.500');
      await r.step(async () => {
        press(ms, 'Enter');
        await settle();
      });
      expect(doc.updateAlignmentBounds).toHaveBeenCalledWith('b', { timeBegin: 1.5, timeEnd: 3.5 });
      expect(document.activeElement).toBe(ms); // Enter keeps the caret, so a nudge can follow
      await r.unmount();
    });

    it('Up and Down step the box under the caret, carrying across boxes, and leaving saves', async () => {
      const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
      const r = await renderComponent(element(doc, makeOps()));
      const ms = timeBox(r.container, 2, 'end', 'milliseconds');
      await r.step(() => ms.focus());
      await r.step(() => press(ms, 'ArrowUp'));
      expect(timeGroup(r.container, 2, 'end').dataset.value).toBe('0:03.010');
      await r.step(() => press(ms, 'ArrowDown', { shiftKey: true }));
      expect(timeGroup(r.container, 2, 'end').dataset.value).toBe('0:02.910');
      const s = timeBox(r.container, 2, 'end', 'seconds');
      await r.step(() => press(s, 'ArrowUp'));
      expect(timeGroup(r.container, 2, 'end').dataset.value).toBe('0:03.910');
      await r.step(async () => {
        ms.blur();
        await settle();
      });
      expect(doc.updateAlignmentBounds).toHaveBeenCalledWith('b', {
        timeBegin: 1.5,
        timeEnd: 3.91,
      });
      await r.unmount();
    });

    it('Escape puts a time back, and a letter never lands in a box', async () => {
      const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
      const r = await renderComponent(element(doc, makeOps()));
      const s = timeBox(r.container, 2, 'start', 'seconds');
      await r.step(() => s.focus());
      await r.step(() => setValue(s, '02'));
      expect(timeGroup(r.container, 2, 'start').dataset.value).toBe('0:02.500');
      await r.step(() => press(s, 'Escape'));
      expect(timeGroup(r.container, 2, 'start').dataset.value).toBe('0:01.500');
      const letter = press(s, 'x');
      expect(letter.defaultPrevented).toBe(true);
      expect(doc.updateAlignmentBounds).not.toHaveBeenCalled();
      await r.unmount();
    });

    it('refuses a boundary that runs into a neighbour, past the recording, or past its own other end', async () => {
      const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
      const r = await renderComponent(element(doc, makeOps({ duration: 4 })));
      const tryValue = async (box, digits) => {
        await r.step(() => box.focus());
        await r.step(() => setValue(box, digits));
        await r.step(async () => {
          press(box, 'Enter');
          await settle();
        });
      };
      await tryValue(timeBox(r.container, 2, 'start', 'seconds'), '01'); // before the first ends (1.5)
      await tryValue(timeBox(r.container, 1, 'end', 'seconds'), '02'); // into the second (starts 1.5)
      await tryValue(timeBox(r.container, 2, 'end', 'seconds'), '05'); // past a 4 s recording
      await tryValue(timeBox(r.container, 2, 'end', 'seconds'), '01'); // no length left
      expect(doc.updateAlignmentBounds).not.toHaveBeenCalled();
      expect(timeGroup(r.container, 2, 'start').dataset.value).toBe('0:01.500');
      expect(timeGroup(r.container, 1, 'end').dataset.value).toBe('0:01.500');
      expect(timeGroup(r.container, 2, 'end').dataset.value).toBe('0:03.000');
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

  // The trash takes the segment AND its text, unless annotations are built on
  // that text, in which case it asks in place. The old confirm dialog asked
  // every time, and its default kept the text, which left the segment's
  // utterance behind in the baseline whenever the box went unticked.
  describe('deleting a segment from its row', () => {
    const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const trashOf = (container, id) =>
      container.querySelector(`[data-segment-id="${id}"] button[aria-label="Delete segment"]`);

    it('goes straight through, text included, when nothing is annotated', async () => {
      const ops = makeOps();
      const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
      const r = await renderComponent(element(doc, ops));
      click(trashOf(r.container, 'a'));
      await settle();
      expect(ops.handleDeleteAlignment).toHaveBeenCalledWith('a', { deleteText: true });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await r.unmount();
    });

    it('asks in place when the text carries annotations, and can keep the text', async () => {
      const ops = makeOps();
      const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
      // A word over "the" with one annotation on it, in the shape layerInfo has.
      doc.layerInfo = {
        primaryTextLayer: { tokenLayers: [] },
        primaryTokenLayer: {
          id: 'wl',
          tokens: [{ id: 'w1', begin: 0, end: 3 }],
          spanLayers: [{ spans: [{ id: 's1', tokens: ['w1'], value: 'DET' }] }],
        },
        sentenceTokenLayer: { tokens: [] },
        spanLayers: { sentence: [] },
      };
      doc.vocabularies = {};
      const r = await renderComponent(element(doc, ops));
      click(trashOf(r.container, 'a'));
      await settle();
      expect(ops.handleDeleteAlignment).not.toHaveBeenCalled();
      const pop = document.querySelector('[role="dialog"]');
      expect(pop.textContent).toContain('1 annotation on this text.');
      click([...pop.querySelectorAll('button')].find((b) => b.textContent === 'Keep text'));
      await settle();
      expect(ops.handleDeleteAlignment).toHaveBeenCalledWith('a', { deleteText: false });
      await r.unmount();
    });
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

// Speech detection's proposals share this list with the real segments. What
// matters is that they sit in time order, hold nothing until typed into, and
// go through the same createAlignment a hand-drawn segment does.
describe('TranscriptList proposals', () => {
  const PROPOSALS = [
    { id: 'vad-1', timeBegin: 0.75, timeEnd: 1.4 },
    { id: 'vad-2', timeBegin: 3.2, timeEnd: 4.0 },
  ];
  const withVad = (over = {}) =>
    makeOps({
      vad: { proposals: PROPOSALS, dismiss: vi.fn(), ...over },
    });
  const proposalRows = (root) => all(root, '[data-vad-proposal-row]');
  const proposalText = (root, id) => root.querySelector(`[data-vad-proposal-row="${id}"] textarea`);

  it('places each proposal in time order among the segments', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const r = await renderComponent(element(doc, withVad()));
    // Segment a [0, 1.5], proposal 1 at 0.75, segment b [1.5, 3], proposal 2 at 3.2.
    const kinds = all(r.container, '[data-segment-id]').map((row) =>
      row.hasAttribute('data-vad-proposal-row') ? 'proposal' : 'segment',
    );
    expect(kinds).toEqual(['segment', 'proposal', 'segment', 'proposal']);
    expect(proposalRows(r.container)).toHaveLength(2);
    // The count in the header is about real segments, not proposals.
    expect(r.container.textContent).toContain('2 segments');
  });

  it('shows a proposal empty, and writes nothing until it is typed into', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const r = await renderComponent(element(doc, withVad()));
    const box = proposalText(r.container, 'vad-1');
    expect(box.value).toBe('');
    press(box, 'Enter');
    await settle();
    expect(doc.createAlignment).not.toHaveBeenCalled();
  });

  it('creates a segment with the proposed times when one is typed into', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const r = await renderComponent(element(doc, withVad()));
    const box = proposalText(r.container, 'vad-2');
    setValue(box, '  a new utterance  ');
    press(box, 'Enter');
    await settle();
    expect(doc.createAlignment).toHaveBeenCalledWith({
      text: 'a new utterance',
      timeBegin: 3.2,
      timeEnd: 4.0,
      speaker: '',
    });
  });

  it('saves what was typed into a proposal when focus leaves it', async () => {
    // The bug this guards: a proposal took Enter and nothing else, so text
    // typed into one and then navigated away from went silently: the row is
    // not data, so nothing was there to warn about losing.
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const r = await renderComponent(element(doc, withVad()));
    const box = proposalText(r.container, 'vad-1');
    setValue(box, 'heard this much');
    await r.step(() => blur(box));
    await settle();
    expect(doc.createAlignment).toHaveBeenCalledWith({
      text: 'heard this much',
      timeBegin: 0.75,
      timeEnd: 1.4,
      speaker: '',
    });
  });

  it('does not create anything from a proposal nobody typed into', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const r = await renderComponent(element(doc, withVad()));
    const box = proposalText(r.container, 'vad-1');
    await r.step(() => blur(box));
    await settle();
    expect(doc.createAlignment).not.toHaveBeenCalled();
  });

  it('saves a proposal once, though Enter is followed by the blur it causes', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const r = await renderComponent(element(doc, withVad()));
    const box = proposalText(r.container, 'vad-2');
    setValue(box, 'said once');
    press(box, 'Enter');
    await settle();
    await r.step(() => blur(box));
    await settle();
    expect(doc.createAlignment).toHaveBeenCalledTimes(1);
  });

  it('plays the proposed stretch on entry, like a segment row', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const ops = withVad();
    const r = await renderComponent(element(doc, ops));
    await r.step(() => proposalText(r.container, 'vad-1').focus());
    expect(ops.setSelection).toHaveBeenCalledWith({ start: 0.75, end: 1.4 });
    expect(ops.playRange).toHaveBeenCalledWith({ start: 0.75, end: 1.4 });
  });

  it('discards a proposal without touching the document', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const ops = withVad();
    const r = await renderComponent(element(doc, ops));
    r.container
      .querySelector(
        '[data-vad-proposal-row="vad-1"] button[aria-label="Discard proposed segment"]',
      )
      .click();
    await settle();
    expect(ops.vad.dismiss).toHaveBeenCalledWith('vad-1');
    expect(doc.createAlignment).not.toHaveBeenCalled();
  });

  it('offers no proposals to a reader', async () => {
    const doc = makeDoc({ body: 'the cat', tokens: TOKENS });
    const r = await renderComponent(element(doc, withVad(), true));
    expect(proposalRows(r.container)).toHaveLength(0);
  });
});
