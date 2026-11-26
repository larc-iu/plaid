// This app's keyboard shortcuts, as one table. A handler asks `keys.is(id, e)`,
// a legend asks `keys.caps(id)`, and a person's own bindings (Profile →
// Keyboard) are laid over the defaults here. See @ui/lib/keymap.js for the
// shape of an action and @ui/lib/chords.js for the chord grammar.
//
// WHAT IS NOT REBINDABLE, and why it is listed anyway. Keys whose meaning is
// where you are, not what you asked for, stay put: Enter moves on, Tab and the
// arrows move, Escape backs out, Backspace at the start of a morpheme merges
// it, and `-` and `=` in a morpheme form ARE the notation. In a cell these run
// through an ordered chain where each handler may claim the key, and a list or
// a gathered expression changes whose key it is, so "Enter" is not one action
// that could be moved elsewhere. They are here as `fixed` rows so that nothing
// else can be bound on top of them.
//
// Mouse gestures, the plain Enter/Escape of forms and dialogs, and the
// Ctrl/Cmd+Enter that posts a comment or saves a new segment are not here at
// all: no other action shares their scope, so there is nothing to collide with.

import { createKeymap } from '@ui/lib/keymap.js';
import { msg } from '@ui/lib/i18n.js';

// Labels are messages (msg): the screen that shows one translates it.

const fixed = (scope, ...keyList) =>
  keyList.map((k) => ({
    id: `fixed:${scope}:${k}`,
    scope,
    group: null,
    label: k,
    keys: [k],
    fixed: true,
  }));

export const KEY_GROUPS = [
  { id: 'anywhere', label: msg('Anywhere') },
  { id: 'analyze', label: msg('Analyze') },
  { id: 'morphemes', label: msg('Analyze: morpheme forms') },
  { id: 'popover', label: msg('Analyze: lexicon popover') },
  { id: 'media', label: msg('Media') },
];

export const KEY_ACTIONS = [
  {
    id: 'global.search',
    scope: 'global',
    group: 'anywhere',
    label: msg('Go to the search box'),
    keys: ['/'],
    outsideText: true,
  },

  // ---- Analyze grid ------------------------------------------------------
  {
    id: 'analyze.accept',
    scope: 'analyze',
    group: 'analyze',
    label: msg('Accept everything proposed on the word or sentence'),
    keys: ['Mod+Enter'],
  },
  {
    id: 'analyze.discard',
    scope: 'analyze',
    group: 'analyze',
    label: msg('Discard everything proposed on the word or sentence'),
    keys: ['Mod+Backspace', 'Mod+Delete'],
  },
  {
    id: 'analyze.nextUnverified',
    scope: 'analyze',
    group: 'analyze',
    label: msg('Next word with something to review'),
    keys: ['Mod+Shift+ArrowDown'],
  },
  {
    id: 'analyze.prevUnverified',
    scope: 'analyze',
    group: 'analyze',
    label: msg('Previous word with something to review'),
    keys: ['Mod+Shift+ArrowUp'],
  },
  {
    id: 'analyze.nextLink',
    scope: 'analyze',
    group: 'analyze',
    label: msg('Next lexicon link to review'),
    keys: ['Mod+ArrowDown'],
  },
  {
    id: 'analyze.prevLink',
    scope: 'analyze',
    group: 'analyze',
    label: msg('Previous lexicon link to review'),
    keys: ['Mod+ArrowUp'],
  },
  {
    id: 'analyze.alternatives',
    scope: 'analyze',
    group: 'analyze',
    label: msg('List the other values seen for this form'),
    keys: ['Alt+ArrowDown'],
  },
  {
    // R51. F2 is rename in a file manager and edits a cell in a spreadsheet,
    // and no system or window manager takes it. On a Mac keyboard it may need Fn.
    id: 'analyze.respell',
    scope: 'analyze',
    group: 'analyze',
    label: msg('Respell the word'),
    keys: ['F2'],
  },
  {
    id: 'analyze.gatherLeft',
    scope: 'analyze',
    group: 'analyze',
    label: msg('Multi-word expression: take the word on the left'),
    keys: ['Shift+ArrowLeft'],
  },
  {
    id: 'analyze.gatherRight',
    scope: 'analyze',
    group: 'analyze',
    label: msg('Multi-word expression: take the word on the right'),
    keys: ['Shift+ArrowRight'],
  },
  {
    id: 'analyze.gatherLeftSkip',
    scope: 'analyze',
    group: 'analyze',
    label: msg('Multi-word expression: skip a word to the left'),
    keys: ['Mod+Shift+ArrowLeft'],
  },
  {
    id: 'analyze.gatherRightSkip',
    scope: 'analyze',
    group: 'analyze',
    label: msg('Multi-word expression: skip a word to the right'),
    keys: ['Mod+Shift+ArrowRight'],
  },
  ...fixed(
    'analyze',
    'Enter',
    'Shift+Enter',
    'Tab',
    'Shift+Tab',
    'Escape',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Backspace',
    'Delete',
  ),

  // ---- Morpheme forms (inside the grid, so inside its scope) --------------
  {
    id: 'morph.zero',
    scope: 'analyze.morph',
    group: 'morphemes',
    label: msg('Type a zero morph ∅'),
    keys: ['Alt+0'],
  },
  {
    id: 'morph.literalHyphen',
    scope: 'analyze.morph',
    group: 'morphemes',
    label: msg('Type a hyphen without splitting'),
    keys: ['Alt+-'],
  },
  {
    id: 'morph.literalEquals',
    scope: 'analyze.morph',
    group: 'morphemes',
    label: msg('Type an equals sign without splitting'),
    keys: ['Alt+='],
  },

  ...fixed('analyze.morph', '-', '='),

  // ---- The lexicon popover. Its search box keeps every key to itself, so it
  // is a scope of its own and not part of the grid's.
  {
    id: 'popover.linkAll',
    scope: 'popover',
    group: 'popover',
    label: msg('Link the highlighted entry to every unlinked occurrence'),
    keys: ['Shift+Enter'],
  },
  {
    id: 'popover.createNow',
    scope: 'popover',
    group: 'popover',
    label: msg('Create the entry as typed'),
    keys: ['Mod+Enter'],
  },
  {
    // The two above at once. A row of its own rather than "whichever chord
    // the other two happen to share": the handler used to test Ctrl/Cmd and
    // Shift by hand, so moving either of them left the pair behind on the
    // chord nobody was bound to any more.
    id: 'popover.createAndLinkAll',
    scope: 'popover',
    group: 'popover',
    label: msg('Create the entry as typed and link it to every unlinked occurrence'),
    keys: ['Mod+Shift+Enter'],
  },
  ...fixed('popover', 'Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown'),

  // ---- Media tab -----------------------------------------------------------
  {
    id: 'media.playPause',
    scope: 'media',
    group: 'media',
    label: msg('Play or pause the recording'),
    keys: ['Space'],
    outsideText: true,
  },
  {
    id: 'media.playSegment',
    scope: 'media',
    group: 'media',
    label: msg('Play or pause the segment you are in'),
    keys: ['Shift+Space'],
  },
  {
    id: 'media.seekBack',
    scope: 'media',
    group: 'media',
    label: msg('Back one second'),
    keys: ['Shift+ArrowLeft'],
  },
  {
    id: 'media.seekForward',
    scope: 'media',
    group: 'media',
    label: msg('Forward one second'),
    keys: ['Shift+ArrowRight'],
  },
  {
    id: 'media.faster',
    scope: 'media',
    group: 'media',
    label: msg('Play faster'),
    keys: ['Shift+ArrowUp'],
  },
  {
    id: 'media.slower',
    scope: 'media',
    group: 'media',
    label: msg('Play slower'),
    keys: ['Shift+ArrowDown'],
  },
  {
    id: 'media.prevRow',
    scope: 'media',
    group: 'media',
    label: msg('Previous segment'),
    keys: ['Alt+ArrowUp'],
  },
  {
    id: 'media.nextRow',
    scope: 'media',
    group: 'media',
    label: msg('Next segment'),
    keys: ['Alt+ArrowDown'],
  },
  {
    // Alt, not Mod: Ctrl/Cmd+Enter saves the timeline's new-segment popover.
    id: 'media.split',
    scope: 'media',
    group: 'media',
    label: msg('Split the segment at playback, between the words at the caret'),
    keys: ['Alt+Enter'],
  },
  {
    // On a Mac this is the key that types µ, in a transcript row only.
    id: 'media.merge',
    scope: 'media',
    group: 'media',
    label: msg('Merge the segment with the next one'),
    keys: ['Alt+m'],
  },
  ...fixed(
    'media',
    'Enter',
    'Escape',
    'Tab',
    'Shift+Tab',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Backspace',
    'Delete',
    'Mod+Enter',
  ),
];

/** The one keymap of this app. */
export const keys = createKeymap(KEY_ACTIONS);
