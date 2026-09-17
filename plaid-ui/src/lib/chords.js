// Keyboard chords as data: one grammar, one matcher, one label.
//
// Every handler used to spell its own test (`e.key === 'Enter' && (e.ctrlKey ||
// e.metaKey)`), about fifty of them, and a legend beside it spelled the same
// chord again by hand. A chord is now a string, a handler asks a keymap whether
// an event is the chord bound to an ACTION, and the legend asks the same keymap
// what to print. That is what lets a person rebind one.
//
// THE GRAMMAR is `[Mod+][Alt+][Shift+]Key`, in that order.
//
//   Mod    Ctrl or Cmd. Every Ctrl shortcut here also takes Cmd, so the two are
//          one modifier and no chord can tell them apart.
//   Key    what `KeyboardEvent.key` says: `Enter`, `ArrowUp`, `Backspace`, `F2`,
//          or a character. A letter is lower case (`Mod+k`). `Space` is spelled
//          out, since a chord ending in a blank reads as a typo.
//
// SHIFT IS PART OF A CHARACTER, NOT A MODIFIER ON IT. `/` is a bare key on a US
// keyboard and Shift+7 on a German one, and both mean "the slash". So a chord
// whose key is a character that is not a letter never carries `Shift`, and an
// event producing one is read without it. Letters and named keys keep it
// (`Shift+Enter`, `Mod+Shift+k`).
//
// ALT REWRITES THE CHARACTER ON A MAC. Option+0 is º, Option+- is an en dash and
// Option+= is ≠, so matching the character alone left every Alt chord dead
// there. With Alt held an event therefore answers to TWO chords: the one its
// character spells, when that is plain ASCII (a layout that keeps `-` on
// another physical key still has its Alt+-), and the one its physical key
// spells (`Minus` is `-`, `Digit0` is `0`, `KeyK` is `k`).

// Physical keys whose unmodified US character names the chord under Alt.
const CODE_CHARS = {
  Minus: '-',
  NumpadSubtract: '-',
  Equal: '=',
  NumpadAdd: '+',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  NumpadDecimal: '.',
  Slash: '/',
  NumpadDivide: '/',
  NumpadMultiply: '*',
  Backquote: '`',
};
const charOfCode = (code) => {
  if (!code) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^(Digit|Numpad)\d$/.test(code)) return code.slice(-1);
  return CODE_CHARS[code] ?? null;
};

const isLetter = (ch) => ch.toLowerCase() !== ch.toUpperCase();
const isAsciiPrintable = (ch) => ch.length === 1 && ch >= '!' && ch <= '~';
// Keys that are only ever half of a chord.
const BARE_MODIFIERS = new Set(['Control', 'Meta', 'Alt', 'AltGraph', 'Shift', 'CapsLock', 'Fn']);

const spell = ({ mod, alt, shift, key }) =>
  [mod && 'Mod', alt && 'Alt', shift && 'Shift', key].filter(Boolean).join('+');

// A key token with the question of whether Shift counts beside it.
const token = (key) => {
  if (key === ' ' || key === 'Space' || key === 'Spacebar') return { key: 'Space', shifts: true };
  if (key.length !== 1) return { key, shifts: true };
  return isLetter(key) ? { key: key.toLowerCase(), shifts: true } : { key, shifts: false };
};

/**
 * A chord string in canonical spelling, or null when it is not one. Tolerates
 * modifier order, `Ctrl`/`Cmd`/`Meta` for `Mod`, `Option` for `Alt`, and case.
 */
export function canonicalChord(chord) {
  if (typeof chord !== 'string' || chord === '') return null;
  // The key may itself be `+`: split on the separators, not on every plus.
  const parts = chord === '+' ? ['+'] : chord.split(/\+(?=.)/);
  const keyPart = parts.pop();
  if (!keyPart) return null;
  const has = { mod: false, alt: false, shift: false };
  for (const raw of parts) {
    const m = raw.trim().toLowerCase();
    if (m === 'mod' || m === 'ctrl' || m === 'control' || m === 'cmd' || m === 'meta')
      has.mod = true;
    else if (m === 'alt' || m === 'option' || m === 'opt') has.alt = true;
    else if (m === 'shift') has.shift = true;
    else return null;
  }
  const t = token(keyPart.length === 1 ? keyPart : keyPart.trim());
  return spell({ ...has, shift: has.shift && t.shifts, key: t.key });
}

const chordCache = new WeakMap();

/**
 * The canonical chords a keydown answers to: usually one, two under Alt (see
 * the note at the top), none for a bare modifier or a key still being composed.
 * The first is the one to RECORD when a person presses a chord to bind it.
 */
export function chordsOf(e) {
  if (!e || typeof e.key !== 'string') return [];
  const cached = chordCache.get(e);
  if (cached) return cached;
  let out = [];
  if (!BARE_MODIFIERS.has(e.key) && e.key !== 'Dead' && e.key !== 'Unidentified') {
    const mods = { mod: !!(e.ctrlKey || e.metaKey), alt: !!e.altKey };
    const of = (key) => {
      const t = token(key);
      return spell({ ...mods, shift: !!e.shiftKey && t.shifts, key: t.key });
    };
    // Space by its physical key as well: its `key` is a blank, and under some
    // modifiers a non-breaking one.
    const typed = e.code === 'Space' ? 'Space' : e.key;
    const physical = mods.alt ? charOfCode(e.code) : null;
    if (mods.alt && typed.length === 1 && !isAsciiPrintable(typed)) {
      out = physical ? [of(physical)] : [];
    } else {
      out = [of(typed)];
      if (physical && of(physical) !== out[0]) out.push(of(physical));
    }
  }
  if (typeof e === 'object') chordCache.set(e, out);
  return out;
}

/** Is this keydown the chord? `chord` must already be canonical. */
export const matchesChord = (chord, e) => chordsOf(e).includes(chord);

/**
 * Would this chord type into a text box? True for a bare character or Space,
 * with or without Shift. Such a chord can only belong to an action that fires
 * outside text boxes.
 */
export function chordTypes(chord) {
  const c = canonicalChord(chord);
  if (!c) return false;
  const parts = c === '+' ? ['+'] : c.split(/\+(?=.)/);
  const key = parts.pop();
  if (parts.includes('Mod') || parts.includes('Alt')) return false;
  return key.length === 1 || key === 'Space';
}

// Chords the browser or the platform acts on before a page can, or that no
// page should take from its user. Refused when a person records one.
const RESERVED = new Set(
  [
    ...'acvxzyfgprtwnqlsho'.split('').map((k) => `Mod+${k}`),
    ...'tnpwij'.split('').map((k) => `Mod+Shift+${k}`),
    'Mod+-',
    'Mod+=',
    'Mod++',
    'Mod+0',
    'Mod+Tab',
    'Mod+Shift+Tab',
    'Alt+Tab',
    'Alt+F4',
    'Mod+Space',
    'Alt+Space',
    'Mod+ArrowLeft',
    'Mod+ArrowRight',
    'Alt+ArrowLeft',
    'Alt+ArrowRight',
    'F1',
    'F5',
    'F11',
    'F12',
    'Tab',
    'Shift+Tab',
  ].map(canonicalChord),
);
export const isReservedChord = (chord) => RESERVED.has(canonicalChord(chord));

const isMacPlatform = () =>
  typeof navigator !== 'undefined' &&
  /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || '');

// Keys a sentence names in full, where a keycap shows a glyph.
const WORD_KEYS = new Set(['Enter', 'Backspace', 'Delete']);
const KEY_LABELS = {
  Enter: '↵',
  Backspace: '⌫',
  Delete: 'Del',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Space',
};

/**
 * What to print on the keycaps of a chord, one string per cap, in the notation
 * the legends already use (⇧ ↵ ⌫ and the arrows). `Mod` is ⌘ on a Mac and Ctrl
 * elsewhere, and Alt is ⌥ there. With `words`, the caps a sentence can carry
 * instead (a tooltip, a toast): Shift, Enter, Backspace, Cmd, Option.
 */
export function chordCaps(chord, { mac = isMacPlatform(), words = false } = {}) {
  const c = canonicalChord(chord);
  if (!c) return [];
  const parts = c === '+' ? ['+'] : c.split(/\+(?=.)/);
  const key = parts.pop();
  const mod = mac ? (words ? 'Cmd' : '⌘') : 'Ctrl';
  const alt = mac ? (words ? 'Option' : '⌥') : 'Alt';
  const caps = parts.map((m) => (m === 'Mod' ? mod : m === 'Alt' ? alt : words ? 'Shift' : '⇧'));
  const label = words && WORD_KEYS.has(key) ? key : KEY_LABELS[key];
  caps.push(label ?? (key.length === 1 ? key.toUpperCase() : key));
  return caps;
}

/** The same as one string: `Ctrl+⇧+↓`, or `Ctrl+Shift+↓` in words. */
export const chordText = (chord, opts) => chordCaps(chord, opts).join('+');
