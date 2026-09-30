import { describe, expect, it } from 'vitest';
import {
  editLogBody,
  editLogGaps,
  editLogIsEmpty,
  inferEdit,
  rebaseEditLog,
  recordEdit,
  sendEditLog,
  settleEditLog,
  startEditLog,
  unsendEditLog,
} from './editLog.js';
import { applyTextOps } from '../../../plaid-client-js/src/textEdits.js';

// A text box as a browser changes it: a value and a selection (UTF-16), and
// each action reports the value and selection before and after, which is all
// the log is told.
function box(value) {
  let log = startEditLog(value, 'd0');
  let sel = { start: value.length, end: value.length };
  const change = (next, caret) => {
    log = recordEdit(log, value, sel, next, caret);
    value = next;
    sel = { start: caret, end: caret };
    // the invariant, after every step
    expect(editLogBody(log)).toBe(value);
    expect(applyTextOps(log.base, log.ops)).toBe(value);
  };
  const before = (at) => {
    const cu = value.charCodeAt(at - 1);
    return cu >= 0xdc00 && cu <= 0xdfff && at >= 2 ? 2 : 1;
  };
  const after = (at) => {
    const cu = value.charCodeAt(at);
    return cu >= 0xd800 && cu <= 0xdbff ? 2 : 1;
  };
  const b = {
    get log() {
      return log;
    },
    get value() {
      return value;
    },
    select(start, end = start) {
      sel = { start, end };
      return b;
    },
    type(text) {
      change(value.slice(0, sel.start) + text + value.slice(sel.end), sel.start + text.length);
      return b;
    },
    backspace() {
      if (sel.start !== sel.end) return b.cut();
      const n = before(sel.start);
      change(value.slice(0, sel.start - n) + value.slice(sel.start), sel.start - n);
      return b;
    },
    del() {
      if (sel.start !== sel.end) return b.cut();
      change(value.slice(0, sel.start) + value.slice(sel.start + after(sel.start)), sel.start);
      return b;
    },
    wordBackspace() {
      let at = sel.start;
      while (at > 0 && /\s/.test(value[at - 1])) at -= 1;
      while (at > 0 && !/\s/.test(value[at - 1])) at -= 1;
      change(value.slice(0, at) + value.slice(sel.start), at);
      return b;
    },
    cut() {
      change(value.slice(0, sel.start) + value.slice(sel.end), sel.start);
      return b;
    },
    // a value the selection does not explain, with the caret where the browser leaves it
    set(next, caret = next.length) {
      change(next, caret);
      return b;
    },
  };
  return b;
}

const gapsOf = (b) => editLogGaps(b.log);

describe('inferEdit', () => {
  it('reads typing, Backspace and Delete from the caret, in code points', () => {
    expect(inferEdit('𐌰b', { start: 2, end: 2 }, '𐌰xb', 3)).toEqual({
      type: 'insert',
      index: 1,
      value: 'x',
    });
    expect(inferEdit('a𐌰b', { start: 3, end: 3 }, 'ab', 1)).toEqual({
      type: 'delete',
      index: 1,
      value: 1,
    });
    expect(inferEdit('a𐌰b', { start: 1, end: 1 }, 'ab', 1)).toEqual({
      type: 'delete',
      index: 1,
      value: 1,
    });
  });

  it('places a letter typed into a run of the same letter where the caret was', () => {
    // `aa|a` plus `a`: the trim would say the end, the caret says index 2
    expect(inferEdit('aaa', { start: 2, end: 2 }, 'aaaa', 3)).toEqual({
      type: 'insert',
      index: 2,
      value: 'a',
    });
    // Backspace at `a|aa`
    expect(inferEdit('aaa', { start: 1, end: 1 }, 'aa', 0)).toEqual({
      type: 'delete',
      index: 0,
      value: 1,
    });
  });

  it('reads a selection typed over as a replace', () => {
    expect(inferEdit('the cat sat', { start: 4, end: 7 }, 'the d sat', 5)).toEqual({
      type: 'replace',
      index: 4,
      length: 3,
      value: 'd',
    });
  });

  it('falls back to the common start and end when the caret does not explain the change', () => {
    // undo: `dog` back to `cat` with the caret left at the end
    expect(inferEdit('the dog sat', { start: 11, end: 11 }, 'the cat sat', 11)).toEqual({
      type: 'replace',
      index: 4,
      length: 3,
      value: 'cat',
    });
    // no selection known at all
    expect(inferEdit('ab', null, 'axb', null)).toEqual({ type: 'insert', index: 1, value: 'x' });
  });

  it('never splits an astral letter in the fallback', () => {
    // 𐌰 and 𐌱 share their first UTF-16 half
    expect(inferEdit('x𐌰y', null, 'x𐌱y', null)).toEqual({
      type: 'replace',
      index: 1,
      length: 1,
      value: '𐌱',
    });
    expect(inferEdit('𐌰𐌱', null, '𐌰', null)).toEqual({ type: 'delete', index: 1, value: 1 });
  });

  it('answers null when nothing changed', () => {
    expect(inferEdit('abc', { start: 1, end: 2 }, 'abc', 2)).toBeNull();
  });
});

describe('the edit log', () => {
  it('keeps a typing run as one insert', () => {
    const b = box('say ').type('h').type('e').type('l').type('l').type('o');
    expect(gapsOf(b)).toEqual([{ start: 4, end: 4, value: 'hello' }]);
  });

  it('keeps Backspace over a word and retyping as one replace', () => {
    const b = box('the cat').backspace().backspace().backspace().type('d').type('o').type('g');
    expect(b.value).toBe('the dog');
    expect(gapsOf(b)).toEqual([{ start: 4, end: 7, value: 'dog' }]);
  });

  it('reads Delete forward and a word deleted with Ctrl+Backspace', () => {
    const b = box('the big dog ran').select(4).del().del().del().del();
    expect(gapsOf(b)).toEqual([{ start: 4, end: 8, value: '' }]);
    b.select(b.value.length).wordBackspace();
    expect(b.value).toBe('the dog ');
    expect(gapsOf(b)).toEqual([
      { start: 4, end: 8, value: '' },
      { start: 12, end: 15, value: '' },
    ]);
  });

  it('reads a selection retyped, a paste and a cut', () => {
    const b = box('the cat sat').select(4, 7).type('d').type('o').type('g');
    expect(gapsOf(b)).toEqual([{ start: 4, end: 7, value: 'dog' }]);
    b.select(0, 3).type('a big');
    expect(b.value).toBe('a big dog sat');
    b.select(9, 13).cut();
    expect(b.value).toBe('a big dog');
    // `dog` and the cut `sat` meet, so they are one gap
    expect(gapsOf(b)).toEqual([
      { start: 0, end: 3, value: 'a big' },
      { start: 4, end: 11, value: 'dog' },
    ]);
  });

  it('reads a drop, as the two changes a browser makes or as one', () => {
    // drag `big ` from before `dog` to after it: a delete, then an insert
    const b = box('a big dog').select(2, 6).cut().select(5).type(' big');
    expect(b.value).toBe('a dog big');
    // one change the selection does not explain
    const c = box('abc def').set(' defabc', 7);
    expect(c.value).toBe(' defabc');
    expect(applyTextOps('abc def', c.log.ops)).toBe(' defabc');
  });

  it('reads IME composition steps, the conversion by the common start and end', () => {
    const b = box('日本 ');
    b.type('k'); // composing `k`
    b.select(b.value.length - 1, b.value.length).type('か'); // `k` converted
    b.set('日本 かな', 5); // composing `かな`
    b.set('日本 仮名', 5); // conversion replaces the whole composition
    expect(gapsOf(b)).toEqual([{ start: 3, end: 3, value: '仮名' }]);
  });

  it('reads undo and redo by the common start and end', () => {
    const b = box('the cat sat').select(4, 7).type('dog');
    b.set('the cat sat', 11); // undo, caret at the end
    expect(editLogIsEmpty(b.log)).toBe(true);
    b.set('the dog sat', 7); // redo
    expect(gapsOf(b)).toEqual([{ start: 4, end: 7, value: 'dog' }]);
  });

  it('counts astral letters and combining marks as code points', () => {
    const b = box('𐌰𐌱 cafe').type('\u0301');
    expect(b.value).toBe('𐌰𐌱 cafe\u0301');
    b.select(2).type('𐌲');
    b.select(4, 6).backspace(); // UTF-16, as the DOM counts
    expect(b.value).toBe('𐌰𐌲 cafe\u0301');
    expect(gapsOf(b)).toEqual([
      { start: 1, end: 2, value: '𐌲' },
      { start: 7, end: 7, value: '\u0301' },
    ]);
  });

  it('reads a change from its own body when told a stale previous value', () => {
    let log = startEditLog('abc');
    log = recordEdit(log, 'something else', { start: 0, end: 0 }, 'abxc', 3);
    expect(editLogBody(log)).toBe('abxc');
    expect(editLogGaps(log)).toEqual([{ start: 2, end: 2, value: 'x' }]);
  });

  it('keeps its net change once it holds many ops', () => {
    const b = box('');
    for (let i = 0; i < 300; i += 1) b.type(i % 7 === 6 ? ' ' : 'a');
    expect(b.log.ops.length).toBeLessThan(200);
    expect(gapsOf(b)).toEqual([{ start: 0, end: 0, value: b.value }]);
  });
});

describe('sending and rebasing a log', () => {
  it('splits at a send, and later typing is relative to the sent text', () => {
    let log = startEditLog('the dog', 'd0');
    log = recordEdit(log, 'the dog', { start: 7, end: 7 }, 'the dogs', 8);
    const { sent, rest } = sendEditLog(log);
    expect(sent).toEqual({
      base: 'the dog',
      digest: 'd0',
      gaps: [{ start: 7, end: 7, value: 's' }],
    });
    expect(rest).toEqual({ base: 'the dogs', digest: null, ops: [], body: 'the dogs' });
    let after = recordEdit(rest, 'the dogs', { start: 0, end: 3 }, 'a dogs', 1);
    expect(editLogGaps(after)).toEqual([{ start: 0, end: 3, value: 'a' }]);
    // landed: the rest's base is what is stored now
    expect(settleEditLog(after, 'd1').digest).toBe('d1');
    // refused: the sent change goes back in front of the rest
    after = unsendEditLog(sent, after);
    expect(after.base).toBe('the dog');
    expect(after.digest).toBe('d0');
    expect(applyTextOps(after.base, after.ops)).toBe('a dogs');
    expect(editLogGaps(after)).toEqual([
      { start: 0, end: 3, value: 'a' },
      { start: 7, end: 7, value: 's' },
    ]);
  });

  it('moves a log onto a text someone else saved, or refuses', () => {
    let log = startEditLog('the dog ran', 'd0');
    log = recordEdit(log, 'the dog ran', { start: 7, end: 7 }, 'the dogs ran', 8);
    const moved = rebaseEditLog(log, 'a dog ran', 'd1');
    expect(moved).toEqual({
      base: 'a dog ran',
      digest: 'd1',
      ops: [{ type: 'insert', index: 5, value: 's' }],
      body: 'a dogs ran',
    });
    expect(rebaseEditLog(log, 'the cat ran', 'd1')).toEqual({ conflict: true });
  });
});
