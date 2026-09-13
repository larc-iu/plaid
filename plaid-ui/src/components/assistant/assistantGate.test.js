import { describe, it, expect } from 'vitest';
import { assistantGate } from './assistantGate.js';

// The gate the two shells used to write out three times each, with two of the
// six expressions disagreeing.

const gate = (over) =>
  assistantGate({ wide: true, open: false, projectId: 'p1', available: true, ...over });

describe('assistantGate', () => {
  it('offers a way in on a project whose assistant is online', () => {
    expect(gate()).toEqual({ showHandle: true, showDock: false, showPicker: false });
  });

  it('shows the dock instead of the handle once it is open', () => {
    expect(gate({ open: true })).toEqual({
      showHandle: false,
      showDock: true,
      showPicker: false,
    });
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
    expect(shut).toEqual({ showHandle: false, showDock: false, showPicker: false });
    expect(gate({ available: false, open: true })).toEqual(shut);
  });

  it('offers nothing in a window too narrow for a side panel', () => {
    expect(gate({ wide: false })).toEqual({
      showHandle: false,
      showDock: false,
      showPicker: false,
    });
    expect(gate({ wide: false, open: true }).showDock).toBe(false);
  });

  it('offers the picker where no project is in scope', () => {
    const none = { projectId: null, available: null };
    expect(gate(none)).toEqual({ showHandle: true, showDock: false, showPicker: false });
    expect(gate({ ...none, open: true })).toEqual({
      showHandle: false,
      showDock: true,
      showPicker: true,
    });
  });

  it('withholds the picker on a route that is under a project of its own', () => {
    // The new-project wizard and the importers: no subject, no annotation to
    // ask about, and a chat about some other project beside a form for making
    // a new one.
    const wizard = { projectId: null, available: null, routeHasProject: true };
    expect(gate(wizard)).toEqual({ showHandle: false, showDock: false, showPicker: false });
    expect(gate({ ...wizard, open: true }).showDock).toBe(false);
  });
});
