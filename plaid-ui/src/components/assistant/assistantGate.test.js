import { describe, it, expect } from 'vitest';
import { assistantGate } from './assistantGate.js';

// The gate the two shells used to write out three times each, with two of the
// six expressions disagreeing.

// `projectScreen`: the screen on show is a project's own (its subject's or its
// route's), as every case below is unless it says otherwise.
const gate = (over) =>
  assistantGate({
    wide: true,
    open: false,
    projectId: 'p1',
    available: true,
    projectScreen: true,
    ...over,
  });

const NONE = { showHandle: false, showDock: false, showPicker: false, noAssistant: false };

describe('assistantGate', () => {
  it('offers a way in on a project whose assistant is online', () => {
    expect(gate()).toEqual({ ...NONE, showHandle: true });
  });

  it('shows the dock instead of the handle once it is open', () => {
    expect(gate({ open: true })).toEqual({ ...NONE, showDock: true });
  });

  it('offers nothing while the answer is unknown, and keeps an open dock open', () => {
    // Withdrawing a handle that was already offered is the flicker this
    // avoids; blinking out a dock the reader is reading is worse.
    expect(gate({ available: null }).showHandle).toBe(false);
    expect(gate({ available: null, open: true }).showDock).toBe(true);
  });

  it('takes the dock away on a project with no assistant, gutter and all', () => {
    // The bug: chip, rail and panel all vanished while the shell kept padding
    // for a panel that was not there. The shell pads by `showDock`.
    const shut = gate({ available: false });
    expect(shut).toEqual(NONE);
    expect(gate({ available: false, open: true })).toEqual(shut);
  });

  it('offers nothing in a window too narrow for a side panel', () => {
    expect(gate({ wide: false })).toEqual(NONE);
    expect(gate({ wide: false, open: true }).showDock).toBe(false);
  });

  it('offers the picker where no project is in scope', () => {
    const none = { projectId: null, available: null, projectScreen: false };
    expect(gate(none)).toEqual({ ...NONE, showHandle: true });
    expect(gate({ ...none, open: true })).toEqual({ ...NONE, showDock: true, showPicker: true });
  });

  it('keeps the panel open and says so when the project picked there has no assistant', () => {
    // The bug: picking a project with no assistant closed the panel, and the
    // button went with it, with nothing said.
    const picked = { projectId: 'p1', projectScreen: false };
    expect(gate({ ...picked, available: false, open: true })).toEqual({
      ...NONE,
      showDock: true,
      showPicker: true,
      noAssistant: true,
    });
    expect(gate({ ...picked, available: false })).toEqual({ ...NONE, showHandle: true });
    // Until discovery answers, the picker stands, with nothing said yet.
    expect(gate({ ...picked, available: null, open: true })).toEqual({
      ...NONE,
      showDock: true,
      showPicker: true,
    });
    // One with an assistant opens its conversation, as before.
    expect(gate({ ...picked, available: true, open: true })).toEqual({ ...NONE, showDock: true });
  });

  it('offers nothing on the app’s own Assistant screen', () => {
    // The tab and the dock both drew the same live turn, each with its own
    // Stop button, and nothing said which one was the live one.
    const here = { assistantRoute: true };
    expect(gate(here)).toEqual(NONE);
    expect(gate({ ...here, open: true })).toEqual(NONE);
  });

  it('withholds the picker on a route that is under a project of its own', () => {
    // The new-project wizard and the importers: no subject, no annotation to
    // ask about, and a chat about some other project beside a form for making
    // a new one.
    const wizard = { projectId: null, available: null, projectScreen: true };
    expect(gate(wizard)).toEqual(NONE);
    expect(gate({ ...wizard, open: true }).showDock).toBe(false);
  });
});
