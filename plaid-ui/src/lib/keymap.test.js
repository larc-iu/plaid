import { describe, it, expect, vi } from 'vitest';
import { createKeymap } from './keymap.js';

const ACTIONS = [
  { id: 'grid.accept', scope: 'grid', group: 'g', label: 'Accept', keys: ['Mod+Enter'] },
  {
    id: 'grid.discard',
    scope: 'grid',
    group: 'g',
    label: 'Discard',
    keys: ['Mod+Backspace', 'Mod+Delete'],
  },
  { id: 'grid.cell.zero', scope: 'grid.cell', group: 'g', label: 'Zero', keys: ['Alt+0'] },
  { id: 'pop.create', scope: 'pop', group: 'p', label: 'Create', keys: ['Mod+Enter'] },
  { id: 'play', scope: 'media', group: 'm', label: 'Play', keys: ['Space'], outsideText: true },
  {
    id: 'fixed:grid:Enter',
    scope: 'grid',
    group: null,
    label: 'Enter',
    keys: ['Enter'],
    fixed: true,
  },
];
const ev = (key, init = {}) => ({ key, code: '', ...init });

describe('createKeymap', () => {
  it('answers for the defaults, and throws on an id nobody declared', () => {
    const km = createKeymap(ACTIONS);
    expect(km.is('grid.accept', ev('Enter', { metaKey: true }))).toBe(true);
    expect(km.is('grid.discard', ev('Delete', { ctrlKey: true }))).toBe(true);
    expect(km.is('grid.accept', ev('Enter'))).toBe(false);
    expect(() => km.is('grid.acept', ev('Enter'))).toThrow(/no action/);
  });

  it('lays a person’s binding over the default, whole', () => {
    const km = createKeymap(ACTIONS);
    const heard = vi.fn();
    km.subscribe(heard);
    km.setOverrides({ 'grid.discard': ['alt+d'] });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(km.is('grid.discard', ev('d', { altKey: true, code: 'KeyD' }))).toBe(true);
    expect(km.is('grid.discard', ev('Backspace', { ctrlKey: true }))).toBe(false);
    expect(km.text('grid.discard', { mac: false })).toBe('Alt+D');
    expect(km.isChanged('grid.discard')).toBe(true);
  });

  it('keeps only overrides it can use', () => {
    const km = createKeymap(ACTIONS);
    km.setOverrides({
      nope: ['Alt+x'],
      'fixed:grid:Enter': ['Alt+x'],
      'grid.accept': ['Hyper+x'],
      'grid.cell.zero': [],
      // The default restated is no change at all.
      'pop.create': ['Cmd+Enter'],
      play: 'Space',
    });
    expect(km.overrides()).toEqual({});
    expect(km.is('grid.accept', ev('Enter', { ctrlKey: true }))).toBe(true);
  });

  it('checks a chord against what would hear it too', () => {
    const km = createKeymap(ACTIONS);
    expect(km.check('grid.cell.zero', 'Mod+Enter')).toMatchObject({
      problem: 'conflict',
      with: { id: 'grid.accept' },
    });
    // The fixed keys hold their chords against everyone.
    expect(km.check('grid.accept', 'Enter')?.with.id).toBe('fixed:grid:Enter');
    // Another scope's chord is free: the popover and the grid share Mod+Enter.
    expect(km.check('pop.create', 'Mod+Backspace')).toBeNull();
    expect(km.check('grid.accept', 'Mod+C')).toEqual({ problem: 'reserved' });
    expect(km.check('grid.accept', 'k')).toEqual({ problem: 'types' });
    expect(km.check('play', 'k')).toBeNull();
    expect(km.check('fixed:grid:Enter', 'Alt+x')).toEqual({ problem: 'fixed' });
  });

  it('checks against a draft, so a freed chord can be taken in the same edit', () => {
    const km = createKeymap(ACTIONS);
    const draft = km.withBinding('grid.accept', 'Alt+a');
    expect(km.check('grid.cell.zero', 'Mod+Enter', draft)).toBeNull();
    expect(km.withBinding('grid.accept', null, draft)).toEqual({});
  });

  // Move A off its chord, give the chord to B, reset A: both would hold it, and
  // whichever handler runs second would be dead with nothing on screen to say so.
  it('takes a default back from whoever was given it meanwhile', () => {
    const km = createKeymap(ACTIONS);
    let draft = km.withBinding('grid.accept', 'Alt+a');
    expect(km.check('grid.cell.zero', 'Mod+Enter', draft)).toBeNull();
    draft = km.withBinding('grid.cell.zero', 'Mod+Enter', draft);
    // And a third that took the second's default, to see the chain through.
    draft = km.withBinding('grid.discard', 'Alt+0', draft);
    expect(km.withBinding('grid.accept', null, draft)).toEqual({});
    // Another scope's use of the same chord is no collision, and stays.
    draft = km.withBinding('pop.create', 'Alt+a', km.withBinding('grid.accept', 'Alt+b'));
    expect(km.withBinding('grid.accept', null, draft)).toEqual({ 'pop.create': ['Alt+a'] });
  });

  it('rejects a table that misspells a chord or repeats an id', () => {
    expect(() => createKeymap([{ ...ACTIONS[0], keys: ['Hyper+x'] }])).toThrow(/not a chord/);
    expect(() => createKeymap([ACTIONS[0], ACTIONS[0]])).toThrow(/duplicate/);
  });
});
