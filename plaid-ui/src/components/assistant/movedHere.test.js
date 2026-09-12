import { describe, it, expect } from 'vitest';
import { movedHere } from './jobs.js';

// The panel stays open across a whole session, so one thread can hold questions
// asked from several documents. Each question is marked with where it came
// from, but only where that CHANGED: marking every one says the same thing over
// and over in a thread that never moved, and says nothing.

const user = (where) => ({ kind: 'user', text: 'q', ...(where ? { where } : {}) });
const reply = { kind: 'assistant', text: 'a' };
const doc = (id) => ({ kind: 'document', id, name: `Text ${id}` });

describe('movedHere', () => {
  it('marks the first question that has a place', () => {
    expect(movedHere([user(doc('1'))], 0)).toBe(true);
  });

  it('does not mark a second question asked from the same place', () => {
    const display = [user(doc('1')), reply, user(doc('1'))];
    expect(movedHere(display, 2)).toBe(false);
  });

  it('marks a question asked from somewhere else', () => {
    const display = [user(doc('1')), reply, user(doc('2'))];
    expect(movedHere(display, 2)).toBe(true);
  });

  it('compares with the last place asked from, not the first', () => {
    // Walked 1 -> 2 -> 1. The last one has moved, even though it is back
    // somewhere the thread has already been.
    const display = [user(doc('1')), reply, user(doc('2')), reply, user(doc('1'))];
    expect(movedHere(display, 4)).toBe(true);
  });

  it('counts the kind as part of the place', () => {
    // An id is unique, but a thread can move between kinds of thing and the
    // chip names the kind's own subject, so a differing kind is a move.
    const display = [
      user({ kind: 'document', id: 'x', name: 'X' }),
      reply,
      user({ kind: 'lexicon', id: 'x', name: 'X' }),
    ];
    expect(movedHere(display, 2)).toBe(true);
  });

  it('marks nothing for a question asked from nowhere', () => {
    // The panel was open on a screen the assistant has no tools for.
    expect(movedHere([user(null)], 0)).toBe(false);
    expect(movedHere([user(doc('1')), reply, user(null)], 2)).toBe(false);
  });

  it('marks the first PLACED question even when unplaced ones came before', () => {
    // A thread begun with no project screen in scope, then walked into one.
    const display = [user(null), reply, user(doc('1'))];
    expect(movedHere(display, 2)).toBe(true);
  });
});
