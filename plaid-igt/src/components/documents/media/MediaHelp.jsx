import React from 'react';
import { cn } from '@/lib/utils';

// The Media tab's "?" legend, the counterpart of the Analyze grid's: every
// gesture the tab answers to, in one place, so nobody has to open the guide to
// learn that Enter saves a row or that Ctrl/Cmd+Space replays a segment.

const Kbd = ({ children }) => (
  <kbd className="rounded border bg-background px-1.5 py-0.5 font-mono text-[11px]">{children}</kbd>
);

const Row = ({ label, children }) => (
  <div className="flex gap-3 py-1">
    <strong className="w-20 shrink-0 pt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
      {label}
    </strong>
    <span className="leading-6">{children}</span>
  </div>
);

export function MediaHelpButton({ open, onToggle }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label="Keyboard help"
      title="Keyboard help"
      onClick={onToggle}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold text-muted-foreground',
        'hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        open &&
          'border-primary bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground',
      )}
    >
      ?
    </button>
  );
}

export function MediaHelp() {
  return (
    <div
      className="rounded-md border bg-muted/40 px-3 py-2 text-sm"
      role="region"
      aria-label="Keyboard help"
    >
      <Row label="Playback">
        <Kbd>Space</Kbd> play / pause, outside a text box · <Kbd>⇧</Kbd>+<Kbd>Space</Kbd> play /
        pause the segment you are in, or the selected stretch · <Kbd>⇧</Kbd>+<Kbd>←</Kbd>{' '}
        <Kbd>→</Kbd> back / forward 1 s · speed 0.2× to 5×, click the value for 1× · loop repeats
        the segment until you pause
      </Row>
      <Row label="Transcript">
        one row per segment, in time order · moving into a row plays it (switch it off above the
        rows) · <Kbd>Enter</Kbd> save the row and move to the next · <Kbd>Esc</Kbd> put the row back
        · <Kbd>Tab</Kbd> next field · the last row adds a segment from the end of the previous one
        to playback at <Kbd>Enter</Kbd>
      </Row>
      <Row label="Times">
        a segment's start and end are boxes of digits · type into the box under the caret ·{' '}
        <Kbd>←</Kbd> <Kbd>→</Kbd> move between boxes · <Kbd>↑</Kbd> <Kbd>↓</Kbd> step the box
        (milliseconds by 10, <Kbd>⇧</Kbd>+ by 100) · <Kbd>Enter</Kbd> or leaving the time saves ·{' '}
        <Kbd>Esc</Kbd> puts it back · a segment cannot run into its neighbours
      </Row>
      <Row label="Timeline">
        drag an empty stretch to add a segment · drag an edge to trim · click a segment to hear it
        and edit its row · in the new-segment popover <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+
        <Kbd>Enter</Kbd> saves, <Kbd>Esc</Kbd> cancels · <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+wheel zooms,
        wheel pans
      </Row>
      <Row label="Speakers">
        a label per segment · the timeline colors each speaker alike · a new segment keeps the last
        speaker · two segments may overlap in time only when their speakers differ (cross-talk)
      </Row>
      <Row label="Machine">
        a row marked <span className="text-violet-600">machine</span> was made by a service ·
        editing or trimming it confirms it
      </Row>
    </div>
  );
}
