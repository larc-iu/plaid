import { describe, it, expect } from 'vitest';
import {
  canonicalChord,
  chordsOf,
  matchesChord,
  chordTypes,
  isReservedChord,
  chordCaps,
  chordText,
} from './chords.js';

const ev = (key, init = {}) => ({ key, code: '', ...init });

describe('canonicalChord', () => {
  it('orders modifiers and folds their aliases', () => {
    expect(canonicalChord('shift+ctrl+ArrowDown')).toBe('Mod+Shift+ArrowDown');
    expect(canonicalChord('Cmd+Enter')).toBe('Mod+Enter');
    expect(canonicalChord('Option+0')).toBe('Alt+0');
  });

  it('lower-cases a letter, spells Space out, and keeps a plus as a key', () => {
    expect(canonicalChord('Mod+K')).toBe('Mod+k');
    expect(canonicalChord('Shift+ ')).toBe('Shift+Space');
    expect(canonicalChord('Mod++')).toBe('Mod++');
    expect(canonicalChord('+')).toBe('+');
  });

  it('drops Shift from a character that is not a letter', () => {
    expect(canonicalChord('Shift+?')).toBe('?');
    expect(canonicalChord('Shift+a')).toBe('Shift+a');
  });

  it('refuses what is not a chord', () => {
    expect(canonicalChord('')).toBeNull();
    expect(canonicalChord('Hyper+x')).toBeNull();
    expect(canonicalChord(null)).toBeNull();
  });
});

describe('chordsOf', () => {
  it('treats Ctrl and Cmd as the one modifier', () => {
    expect(chordsOf(ev('Enter', { ctrlKey: true }))).toEqual(['Mod+Enter']);
    expect(chordsOf(ev('Enter', { metaKey: true }))).toEqual(['Mod+Enter']);
  });

  it('matches modifiers exactly', () => {
    const e = ev('ArrowDown', { ctrlKey: true, shiftKey: true });
    expect(matchesChord('Mod+Shift+ArrowDown', e)).toBe(true);
    expect(matchesChord('Mod+ArrowDown', e)).toBe(false);
  });

  // `/` is Shift+7 on a German keyboard: the same key as far as a chord goes.
  it('reads a shifted character as the character', () => {
    expect(chordsOf(ev('/', { shiftKey: true, code: 'Digit7' }))).toEqual(['/']);
    expect(chordsOf(ev('A', { shiftKey: true, ctrlKey: true }))).toEqual(['Mod+Shift+a']);
  });

  it('finds Space by its physical key', () => {
    expect(chordsOf(ev(' ', { code: 'Space', shiftKey: true }))).toEqual(['Shift+Space']);
    expect(chordsOf(ev(' ', { code: 'Space', shiftKey: true }))).toEqual(['Shift+Space']);
  });

  // macOS rewrites the character under Option, which once left Alt+0, Alt+- and
  // Alt+= dead there.
  it('answers to the physical key when Alt has rewritten the character', () => {
    expect(chordsOf(ev('º', { altKey: true, code: 'Digit0' }))).toEqual(['Alt+0']);
    expect(chordsOf(ev('–', { altKey: true, code: 'Minus' }))).toEqual(['Alt+-']);
    expect(chordsOf(ev('≠', { altKey: true, code: 'Equal' }))).toEqual(['Alt+=']);
    expect(chordsOf(ev('0', { altKey: true, code: 'Numpad0' }))).toEqual(['Alt+0']);
  });

  // A layout with `-` on another physical key keeps its Alt+- too.
  it('answers to both the character and the physical key under Alt', () => {
    expect(chordsOf(ev('-', { altKey: true, code: 'Slash' }))).toEqual(['Alt+-', 'Alt+/']);
    expect(chordsOf(ev('ArrowDown', { altKey: true, code: 'ArrowDown' }))).toEqual([
      'Alt+ArrowDown',
    ]);
  });

  it('is nothing for a bare modifier or a dead key', () => {
    expect(chordsOf(ev('Shift', { shiftKey: true }))).toEqual([]);
    expect(chordsOf(ev('Dead', { altKey: true }))).toEqual([]);
  });
});

describe('what a chord may be', () => {
  it('knows a chord that would type', () => {
    expect(chordTypes('Space')).toBe(true);
    expect(chordTypes('Shift+Space')).toBe(true);
    expect(chordTypes('/')).toBe(true);
    expect(chordTypes('Alt+0')).toBe(false);
    expect(chordTypes('Shift+ArrowUp')).toBe(false);
    expect(chordTypes('F2')).toBe(false);
  });

  it("refuses the browser's own", () => {
    expect(isReservedChord('Ctrl+C')).toBe(true);
    expect(isReservedChord('Cmd+Shift+T')).toBe(true);
    expect(isReservedChord('Mod+Enter')).toBe(false);
  });
});

describe('chordCaps', () => {
  it("prints the platform's modifiers in the legends' notation", () => {
    expect(chordCaps('Mod+Shift+ArrowDown', { mac: false })).toEqual(['Ctrl', '⇧', '↓']);
    expect(chordCaps('Mod+Backspace', { mac: true })).toEqual(['⌘', '⌫']);
    expect(chordText('Alt+k', { mac: true })).toBe('⌥+K');
    expect(chordText('Mod+Shift+Enter', { mac: false, words: true })).toBe('Ctrl+Shift+Enter');
    expect(chordText('Alt+ArrowDown', { mac: true, words: true })).toBe('Option+↓');
  });
});
