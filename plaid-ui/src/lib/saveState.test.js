import { describe, it, expect } from 'vitest';
import { saveStateOf, saveStateText } from './saveState.js';

describe('saveStateOf', () => {
  it('reads a document with nothing on its way as idle', () => {
    expect(saveStateOf(null)).toBe('idle');
    expect(saveStateOf({ isSaving: false, isOffline: true, isLocked: true })).toBe('idle');
  });

  it('puts a lost connection before a lock, and a lock before a plain save', () => {
    expect(saveStateOf({ isSaving: true, isOffline: true, isLocked: true })).toBe('offline');
    expect(saveStateOf({ isSaving: true, isLocked: true })).toBe('locked');
    expect(saveStateOf({ isSaving: true })).toBe('saving');
  });
});

describe('saveStateText', () => {
  it('says each state, and nothing when idle', () => {
    expect(saveStateText('saving')).toBe('Saving…');
    expect(saveStateText('locked')).toBe('In use elsewhere, waiting');
    expect(saveStateText('saved')).toBe('Saved ✓');
    expect(saveStateText('idle')).toBe('');
  });
});
