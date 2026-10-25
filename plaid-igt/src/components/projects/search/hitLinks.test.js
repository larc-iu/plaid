import { afterEach, describe, expect, it } from 'vitest';
import { rememberCaret } from './hitLinks.js';
import { analyzeFocus } from '@/components/documents/hooks/focusHandoff.js';

// A hit's link opens its sentence. A plain click lands this tab on the hit's
// word too. A click that opens the link elsewhere (Ctrl, Cmd, Shift, Alt, the
// middle button) leaves this tab's next Analyze tab alone: the new tab lands
// through the link's own ?focusSentence=.

const click = (init = {}) => new MouseEvent('click', { button: 0, ...init });

afterEach(() => analyzeFocus.clear());

describe('rememberCaret', () => {
  it('hands the word to the Analyze tab on a plain click', () => {
    rememberCaret(click(), 'd1', 's1', 4);
    expect(analyzeFocus.read()).toEqual({ docId: 'd1', sentenceId: 's1', begin: 4 });
  });

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd', { metaKey: true }],
    ['Shift', { shiftKey: true }],
    ['Alt', { altKey: true }],
    ['the middle button', { button: 1 }],
  ])('leaves nothing behind on a click with %s', (_name, init) => {
    rememberCaret(click(init), 'd1', 's1', 4);
    expect(analyzeFocus.read()).toBe(null);
  });
});
