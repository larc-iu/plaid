import { describe, it, expect } from 'vitest';
import { hidesStopped, retryNote, stoppedIn } from './resume.js';

describe('stoppedIn', () => {
  const stopped = { convId: 'c1', steps: ['Read Text 1', 'Counted 12 words'] };

  it('gives back what the stopped turn had done, in its own conversation', () => {
    expect(stoppedIn(stopped, 'c1')).toBe(stopped);
  });

  it('says nothing in another conversation', () => {
    // The panel keeps one thread per project, and the reader can switch
    // threads from its header: an unscoped list put a stopped turn's steps
    // under whatever was on screen next.
    expect(stoppedIn(stopped, 'c2')).toBeNull();
  });

  it('says nothing when nothing was stopped, or nothing is open', () => {
    expect(stoppedIn(null, 'c1')).toBeNull();
    expect(stoppedIn(stopped, null)).toBeNull();
    expect(stoppedIn({ convId: null, steps: [] }, null)).toBeNull();
  });
});

// H8-ASSISTANT-4: a stop is recorded as an error item, and was then read as a
// turn that failed ("Stopped." over "That turn did not finish.").
describe('retryNote', () => {
  const user = { kind: 'user', text: 'count' };
  const stop = { kind: 'error', stopped: true, text: 'Stopped.' };

  it('says the reader stopped a stopped turn, after a reload too, and draws the stop once', () => {
    expect(retryNote([user, stop], null)).toBe('You stopped this turn.');
    expect(retryNote([user], { convId: 'c1', steps: [] })).toBe('You stopped this turn.');
    expect(hidesStopped([user, stop], 1)).toBe(true);
    expect(hidesStopped([user, stop], 0)).toBe(false);
  });

  it('says a turn that failed did not finish, and one with no answer had none', () => {
    expect(retryNote([user, { kind: 'error', text: 'x' }], null)).toBe('That turn did not finish.');
    expect(hidesStopped([user, { kind: 'error', text: 'x' }], 1)).toBe(false);
    expect(retryNote([user], null)).toBe('No answer came back for this message.');
  });
});
