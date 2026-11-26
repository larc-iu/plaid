import { Fragment } from 'react';
import { cn } from '@ui/lib/utils';
import { keys } from '@/lib/keymap.js';
import { t, tx } from '@ui/lib/i18n.js';

// The Media tab's "?" legend, the counterpart of the Analyze grid's: every
// gesture the tab answers to, in one place, so nobody has to open the guide to
// learn that Enter saves a row or that Shift+Space pauses and resumes a segment.

const Kbd = ({ children }) => (
  <kbd className="rounded-sm border bg-background px-1.5 py-0.5 font-mono text-[11px]">
    {children}
  </kbd>
);

// An action's chord as keycaps, in whatever the person has bound it to.
const Chord = ({ id }) =>
  keys.caps(id).map((cap, i) => (
    <Fragment key={i}>
      {i > 0 && '+'}
      <Kbd>{cap}</Kbd>
    </Fragment>
  ));

// A row's clauses, each a message of its own, with a dot between them.
const Row = ({ label, clauses }) => (
  <div className="flex gap-3 py-1">
    <strong className="w-20 shrink-0 pt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
      {label}
    </strong>
    <span className="leading-6">
      {clauses.map((clause, i) => (
        <Fragment key={i}>
          {i > 0 && ' · '}
          {clause}
        </Fragment>
      ))}
    </span>
  </div>
);

export function MediaHelpButton({ open, onToggle }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={t('Keyboard help')}
      title={t('Keyboard help')}
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

// Key names stay as the keyboard shows them.
const ESC = <Kbd>Esc</Kbd>; // i18n-ignore: a key name
const ENTER = <Kbd>Enter</Kbd>; // i18n-ignore: a key name
const TAB = <Kbd>Tab</Kbd>; // i18n-ignore: a key name
const CTRL = <Kbd>Ctrl</Kbd>; // i18n-ignore: a key name
const CMD = <Kbd>Cmd</Kbd>; // i18n-ignore: a key name
const UP = <Kbd>↑</Kbd>;
const DOWN = <Kbd>↓</Kbd>;
const LEFT = <Kbd>←</Kbd>;
const RIGHT = <Kbd>→</Kbd>;
const SHIFT = <Kbd>⇧</Kbd>;
const BACKSPACE = <Kbd>⌫</Kbd>;
const TIMES = <Kbd>×</Kbd>;

export function MediaHelp() {
  const chord = (id) => <Chord id={id} />;
  return (
    <div
      className="rounded-md border bg-muted/40 px-3 py-2 text-sm"
      role="region"
      aria-label={t('Keyboard help')}
    >
      <Row
        label={t('Playback')}
        clauses={[
          tx('{keys} play / pause, outside a text box', { keys: chord('media.playPause') }),
          tx(
            '{keys} pause / resume the segment you are in, or the selected stretch (from its start when playback is elsewhere)',
            { keys: chord('media.playSegment') },
          ),
          tx('{back} {forward} back / forward 1 s', {
            back: chord('media.seekBack'),
            forward: chord('media.seekForward'),
          }),
          tx('{faster} {slower} faster / slower, in the transcript', {
            faster: chord('media.faster'),
            slower: chord('media.slower'),
          }),
          t('speed 0.25× to 5×, click the value for 1×'),
          t('loop repeats the segment until you pause'),
          tx('{esc} to clear the selected stretch', { esc: ESC }),
        ]}
      />
      <Row
        label={t('Transcript')}
        clauses={[
          t('one row per segment, in time order'),
          t('moving into a row plays it (switch it off above the rows)'),
          tx('{enter} to save the row and move to the next', { enter: ENTER }),
          tx('{up} {down} the row above or below, from the start or end of the text', {
            up: UP,
            down: DOWN,
          }),
          tx('{prev} {next} the same from anywhere in the row', {
            prev: chord('media.prevRow'),
            next: chord('media.nextRow'),
          }),
          tx('{esc} to put the row back', { esc: ESC }),
          tx('{tab} next field', { tab: TAB }),
          tx(
            'the last row adds a segment from the end of the previous one to playback at {enter}',
            {
              enter: ENTER,
            },
          ),
          tx('{keys} to split the segment at playback, its text between the words at the caret', {
            keys: chord('media.split'),
          }),
          tx('{keys} to merge it with the next', { keys: chord('media.merge') }),
          t('the bin deletes a segment and its text, asking first when the text has annotations'),
        ]}
      />
      <Row
        label={t('Times')}
        clauses={[
          t("a segment's start and end are boxes of digits"),
          t('type into the box under the caret'),
          tx('{left} {right} to move between boxes', { left: LEFT, right: RIGHT }),
          tx('{up} {down} to step the box (milliseconds by 10, {shift}+ by 100)', {
            up: UP,
            down: DOWN,
            shift: SHIFT,
          }),
          tx('{backspace} to zero the box', { backspace: BACKSPACE }),
          tx('{keys} to play the segment', { keys: chord('media.playSegment') }),
          tx('{enter} or leave the time to save', { enter: ENTER }),
          tx('{esc} to put it back', { esc: ESC }),
          t('a segment cannot run into its neighbours'),
        ]}
      />
      <Row
        label={t('Timeline')}
        clauses={[
          tx(
            'drag an empty stretch to add a segment, typed fresh or by selecting words already in the baseline ({shift}+arrows select there)',
            { shift: SHIFT },
          ),
          t('drag an edge to trim'),
          t('click a segment to hear it and edit its row'),
          t('click the ruler to move playback'),
          t(
            "the selected segment's card splits it at playback and merges it with the next, also outside a text box by the same keys",
          ),
          tx('in the new-segment popover {ctrl}/{cmd}+{enter} to save, {esc} to cancel', {
            ctrl: CTRL,
            cmd: CMD,
            enter: ENTER,
            esc: ESC,
          }),
          tx('{ctrl}/{cmd}+wheel to zoom, wheel to pan', { ctrl: CTRL, cmd: CMD }),
        ]}
      />
      <Row
        label={t('Detection')}
        clauses={[
          t(
            'the waveform button in the Recording header proposes where the utterances are, in the browser',
          ),
          t(
            'a proposal is dashed on the timeline and dashed in the transcript, and holds no text yet',
          ),
          tx('typing into one makes it a segment, saved by {enter} or by moving on', {
            enter: ENTER,
          }),
          tx('{x} to discard it', { x: TIMES }),
          t("the dialog's settings re-propose without running the model again"),
          t('proposals are kept with the document until Discard'),
        ]}
      />
      <Row
        label={t('Speakers')}
        clauses={[
          t('a label per segment'),
          t('the timeline colors each speaker alike'),
          t('a new segment keeps the last speaker'),
          t('two segments may overlap in time only when their speakers differ (cross-talk)'),
        ]}
      />
      <Row
        label={t('Machine')}
        clauses={[
          tx('a row marked <machine>machine</machine> was made by a service', {
            machine: (c) => <span className="text-[color:var(--plaid-machine)]">{c}</span>,
          }),
          t('editing or trimming it confirms it'),
        ]}
      />
    </div>
  );
}
