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
  storedHolds,
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

  it('puts an insert the caret does not place at a word edge rather than inside the next word (F2)', () => {
    // ` to` typed after `went`, or `to ` before `the`: never `o t` inside `the`
    expect(inferEdit('I went the store', null, 'I went to the store', null)).toEqual({
      type: 'insert',
      index: 7,
      value: 'to ',
    });
    // ` الصغير` after `الولد`, where the next word also starts with `ال`
    expect(inferEdit('الولد البيت', null, 'الولد الصغير البيت', null)).toEqual({
      type: 'insert',
      index: 6,
      value: 'الصغير ',
    });
    // a word typed before a word it is the start of
    expect(inferEdit('a cat attack', null, 'a cat at attack', null)).toEqual({
      type: 'insert',
      index: 6,
      value: 'at ',
    });
    // a delete that could take the end of one word and the start of the next
    expect(inferEdit('go to the park', null, 'go the park', null)).toEqual({
      type: 'delete',
      index: 3,
      value: 3,
    });
    // inside a word with nothing to choose, as found
    expect(inferEdit('the dg ran', null, 'the dog ran', null)).toEqual({
      type: 'insert',
      index: 5,
      value: 'o',
    });
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

  // What Chrome reports for a word dragged inside a textarea (seen in a real
  // browser): `deleteByDrag` with the caret left where the word was, then
  // `insertFromDrop` with the dropped word selected. Nothing is captured
  // between the two, so the selection before the drop is the delete's caret.
  it('reads a word dragged inside the box as a delete where it was and an insert where it went (H1-IGT-TEXT-2)', () => {
    const base = 'bo arkin\nbo godung et\ngodung keca\n';
    let log = startEditLog(base, 'd0');
    const dragged = 'bo arkin\n godung et\ngodung keca\n';
    log = recordEdit(log, base, { start: 9, end: 11 }, dragged, 9, 'deleteByDrag');
    const dropped = 'bo arkin\n godung et\ngodung kboeca\n';
    log = recordEdit(log, dragged, { start: 9, end: 9 }, dropped, 30, 'insertFromDrop');
    expect(editLogBody(log)).toBe(dropped);
    expect(editLogGaps(log)).toEqual([
      { start: 9, end: 11, value: '' },
      { start: 30, end: 30, value: 'bo' },
    ]);
    // the same without being told the input's kind
    log = startEditLog(base, 'd0');
    log = recordEdit(log, base, { start: 9, end: 11 }, dragged, 9);
    log = recordEdit(log, dragged, { start: 9, end: 9 }, dropped, 30);
    expect(editLogGaps(log)).toEqual([
      { start: 9, end: 11, value: '' },
      { start: 30, end: 30, value: 'bo' },
    ]);
  });

  it('reads a drop to the left of where the word was (H1-IGT-TEXT-2)', () => {
    const base = 'Tuu vaari\nching loon\nthung ta\n';
    let log = startEditLog(base, 'd0');
    const dragged = 'Tuu vaari\nching loon\n ta\n';
    log = recordEdit(log, base, { start: 21, end: 26 }, dragged, 21, 'deleteByDrag');
    const dropped = 'Tthunguu vaari\nching loon\n ta\n';
    log = recordEdit(log, dragged, { start: 21, end: 21 }, dropped, 6, 'insertFromDrop');
    expect(editLogGaps(log)).toEqual([
      { start: 1, end: 1, value: 'thung' },
      { start: 21, end: 26, value: '' },
    ]);
  });

  // Chrome after Ctrl+Z selects the text it put back, after Ctrl+Shift+Z it
  // leaves the caret after what it redid, wherever the caret was before.
  it('reads an undo where it happened when the caret moved away first (H1-IGT-TEXT-3)', () => {
    const base = 'a\ndi ra\ndi ra\nend\n';
    // select the first `di ra\n` and Delete
    let log = startEditLog(base, 'd0');
    const deleted = 'a\ndi ra\nend\n';
    log = recordEdit(log, base, { start: 2, end: 8 }, deleted, 2, 'deleteContentForward');
    // the caret moves to the end, then Ctrl+Z: the restored line is selected
    log = recordEdit(log, deleted, { start: 12, end: 12 }, base, 8, 'historyUndo');
    expect(editLogBody(log)).toBe(base);
    expect(editLogIsEmpty(log)).toBe(true);
    // Ctrl+Shift+Z with the caret moved away again, then Ctrl+Z
    log = recordEdit(log, base, { start: 0, end: 0 }, deleted, 2, 'historyRedo');
    expect(editLogGaps(log)).toEqual([{ start: 2, end: 8, value: '' }]);
    log = recordEdit(log, deleted, { start: 12, end: 12 }, base, 8, 'historyUndo');
    expect(editLogIsEmpty(log)).toBe(true);
  });

  it('reads an undo of a reduplicated word where it happened (H1-IGT-TEXT-3)', () => {
    const base = 'ta krvaa krvaa ra\nnext line\n';
    let log = startEditLog(base, 'd0');
    // select the first `krvaa `, Backspace, Down, Ctrl+Z
    const deleted = 'ta krvaa ra\nnext line\n';
    log = recordEdit(log, base, { start: 3, end: 9 }, deleted, 3, 'deleteContentBackward');
    log = recordEdit(log, deleted, { start: 16, end: 16 }, base, 9, 'historyUndo');
    expect(editLogIsEmpty(log)).toBe(true);
    // without the input's kind the caret after still places it
    log = startEditLog(base, 'd0');
    log = recordEdit(log, base, { start: 3, end: 9 }, deleted, 3);
    log = recordEdit(log, deleted, { start: 16, end: 16 }, base, 9);
    expect(editLogIsEmpty(log)).toBe(true);
  });

  it('reads an undo of typing, and its redo, at the caret Chrome leaves', () => {
    const base = 'ab ab ab';
    let log = startEditLog(base, 'd0');
    log = recordEdit(log, base, { start: 2, end: 2 }, 'abb ab ab', 3, 'insertText');
    // Ctrl+End, then Ctrl+Z: the caret is left where the letter was
    log = recordEdit(log, 'abb ab ab', { start: 9, end: 9 }, base, 2, 'historyUndo');
    expect(editLogIsEmpty(log)).toBe(true);
    log = recordEdit(log, base, { start: 0, end: 0 }, 'abb ab ab', 3, 'historyRedo');
    expect(editLogGaps(log)).toEqual([{ start: 2, end: 2, value: 'b' }]);
  });

  // The event streams below are what Chrome reported in the igt Baseline box
  // (REV-F-EDITLOG, recorded live): each Delete is its own undo step, and each
  // Ctrl+Z of a forward delete leaves a collapsed caret at the START of what
  // it put back.
  const replay = (base, events) => {
    let log = startEditLog(base, 'd0');
    let value = base;
    let sel = { start: 0, end: 0 };
    for (const [next, start, end, inputType] of events) {
      log = recordEdit(log, value, sel, next, end, inputType);
      value = next;
      sel = { start, end };
      expect(editLogBody(log)).toBe(value);
      expect(applyTextOps(log.base, log.ops)).toBe(value);
    }
    return log;
  };
  // Delete `count` times at `at`, then Ctrl+Z as many times, the caret moved
  // to `away` before the first Ctrl+Z
  const deleteThenUndo = (base, at, count, away = at) => {
    const states = [base];
    for (let i = 1; i <= count; i += 1) states.push(base.slice(0, at) + base.slice(at + i));
    const events = states.slice(1).map((s) => [s, at, at, 'deleteContentForward']);
    events.push(['__move__']);
    for (let i = count - 1; i >= 0; i -= 1) events.push([states[i], at, at, 'historyUndo']);
    let log = startEditLog(base, 'd0');
    let value = base;
    let sel = { start: at, end: at };
    for (const [next, start, end, inputType] of events) {
      if (next === '__move__') {
        sel = { start: away, end: away };
        continue;
      }
      log = recordEdit(log, value, sel, next, end, inputType);
      value = next;
      sel = { start, end };
    }
    return log;
  };

  it('reads each Ctrl+Z of a forward delete where it was deleted, not at the same text before it (REV-F-EDITLOG R1)', () => {
    // `bobi emun kabon`: Delete five times at `emun`, Ctrl+Z five times
    expect(editLogIsEmpty(deleteThenUndo('bestauna bobi emun kabon taruo\n', 14, 5))).toBe(true);
    // `ime ime nasambung`, caret at the second word
    expect(editLogIsEmpty(deleteThenUndo('tabaruon ime ime nasambung\n', 13, 4))).toBe(true);
    // a repeated line by the Delete key, the caret moved away first (H1-IGT-TEXT-3)
    const base = 'meraraouk\npui parair\npui parair\nnext\n';
    expect(editLogIsEmpty(deleteThenUndo(base, 10, 11, 35))).toBe(true);
  });

  it('reads a whole forward delete undone in one step where it was (REV-F-EDITLOG R3)', () => {
    const base = 'x di ra\ndi ra\nend\n';
    const events = [];
    for (let i = 1; i <= 6; i += 1) {
      events.push([base.slice(0, 2) + base.slice(2 + i), 2, 2, 'deleteContentForward']);
    }
    events.push([base, 2, 2, 'historyUndo']);
    expect(editLogIsEmpty(replay(base, events))).toBe(true);
  });

  it('reads Ctrl+Delete over a reduplicated word and its undo (REV-F-EDITLOG R1)', () => {
    const base = 'x ya ya ya\n';
    // the caret after the first `ya`, Ctrl+Delete takes ` ya`, Ctrl+Z
    const log = replay(base, [
      ['x ya ya\n', 4, 4, 'deleteWordForward'],
      [base, 4, 4, 'historyUndo'],
    ]);
    expect(editLogIsEmpty(log)).toBe(true);
    // and redo
    const again = recordEdit(log, base, { start: 4, end: 4 }, 'x ya ya\n', 4, 'historyRedo');
    expect(editLogGaps(again)).toEqual([{ start: 4, end: 7, value: '' }]);
  });

  it('reads a drag undone and redone as the drag, never one wide replace (REV-F-EDITLOG R2)', () => {
    const base = 'Tuu vaari\nching loon\nthung ta\n';
    const dragged = ' vaari\nching loon\nthung ta\n';
    const dropped = ' vaari\nching loon\nthTuuung ta\n';
    const drag = [
      [dragged, 0, 0, 'deleteByDrag'],
      [dropped, 20, 23, 'insertFromDrop'],
    ];
    const want = [
      { start: 0, end: 3, value: '' },
      { start: 23, end: 23, value: 'Tuu' },
    ];
    expect(editLogGaps(replay(base, drag))).toEqual(want);
    // Chrome undoes and redoes the drag as one step, both places at once
    let log = replay(base, [...drag, [base, 0, 3, 'historyUndo']]);
    expect(editLogIsEmpty(log)).toBe(true);
    log = recordEdit(log, base, { start: 0, end: 3 }, dropped, 23, 'historyRedo');
    expect(editLogGaps(log)).toEqual(want);
    // and Ctrl+Z, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Shift+Z over typing then a drag
    log = replay('ab ab\n', [
      ['abc ab\n', 3, 3, 'insertText'],
      ['abc \n', 4, 4, 'deleteByDrag'],
      ['ababc \n', 0, 2, 'insertFromDrop'],
      ['abc ab\n', 4, 6, 'historyUndo'],
      ['ab ab\n', 2, 2, 'historyUndo'],
      ['abc ab\n', 3, 3, 'historyRedo'],
      ['ababc \n', 0, 2, 'historyRedo'],
    ]);
    expect(editLogGaps(log)).toEqual([
      { start: 0, end: 0, value: 'ab' },
      { start: 2, end: 2, value: 'c' },
      { start: 3, end: 5, value: '' },
    ]);
  });

  it('forgets what was undone once something else is typed', () => {
    const log = replay('one two\n', [
      ['one twox\n', 8, 8, 'insertText'],
      ['one two\n', 7, 7, 'historyUndo'],
      ['one yes two\n', 7, 7, 'insertText'],
    ]);
    // a redo the box cannot have (its redo was dropped) is read as a change
    const after = recordEdit(
      log,
      'one yes two\n',
      { start: 7, end: 7 },
      'one yes twox\n',
      12,
      'historyRedo',
    );
    expect(editLogGaps(after)).toEqual([
      { start: 3, end: 3, value: ' yes' },
      { start: 7, end: 7, value: 'x' },
    ]);
  });

  it('keeps a bounded history, and reads an undo past it from the caret', () => {
    let log = startEditLog('', 'd0');
    let value = '';
    for (let i = 0; i < 300; i += 1) {
      log = recordEdit(log, value, { start: i, end: i }, `${value}a`, i + 1, 'insertText');
      value += 'a';
    }
    expect(log.past.length).toBe(200);
    // Ctrl+Z of the whole run in one step: no kept state has the empty text
    log = recordEdit(log, value, { start: 300, end: 300 }, '', 0, 'historyUndo');
    expect(editLogIsEmpty(log)).toBe(true);
    // a log started at a send has no history, and still reads an undo
    const { rest } = sendEditLog(log);
    const after = recordEdit(rest, '', { start: 0, end: 0 }, 'b', 1, 'historyUndo');
    expect(editLogGaps(after)).toEqual([{ start: 0, end: 0, value: 'b' }]);
  });

  it('never reads a stale selection as a wide replace', () => {
    // the selection still covers `cats` when Ctrl+Z takes back the `s`
    // typed before: one letter goes, not the word
    expect(inferEdit('the cats', { start: 4, end: 8 }, 'the cat', 7, 'historyUndo')).toEqual({
      type: 'delete',
      index: 7,
      value: 1,
    });
    // a selection left from before, with the caret after an insert elsewhere
    expect(inferEdit('one two three', { start: 0, end: 3 }, 'one two xthree', 9)).toEqual({
      type: 'insert',
      index: 8,
      value: 'x',
    });
    // a collapsed selection left far before the change
    expect(inferEdit('aa bb aa bb', { start: 0, end: 0 }, 'aa bb aa bbX', 12)).toEqual({
      type: 'insert',
      index: 11,
      value: 'X',
    });
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
    expect(rest).toEqual({
      base: 'the dogs',
      digest: null,
      ops: [],
      raw: 'the dogs',
      body: 'the dogs',
    });
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
      raw: 'a dogs ran',
      body: 'a dogs ran',
    });
    expect(rebaseEditLog(log, 'the cat ran', 'd1')).toEqual({ conflict: true });
  });
});

describe('a body with carriage returns', () => {
  // The box shows `\n` for each `\r\n` and lone `\r`, and the gaps are in the
  // stored body's code points.
  const crlf = 'one\r\ntwo\r\nthree';

  it('shows each line break as a newline, and keeps the stored base', () => {
    const log = startEditLog(crlf, 'd0');
    expect(log.base).toBe(crlf);
    expect(editLogBody(log)).toBe('one\ntwo\nthree');
    expect(editLogIsEmpty(log)).toBe(true);
  });

  it('sends a letter typed at the end as one insert at the stored end', () => {
    let log = startEditLog(crlf, 'd0');
    log = recordEdit(log, 'one\ntwo\nthree', { start: 13, end: 13 }, 'one\ntwo\nthreex', 14);
    expect(editLogBody(log)).toBe('one\ntwo\nthreex');
    expect(editLogGaps(log)).toEqual([{ start: 15, end: 15, value: 'x' }]);
    expect(applyTextOps(log.base, log.ops)).toBe('one\r\ntwo\r\nthreex');
  });

  it('deletes the whole stored line break a deleted newline stands for', () => {
    let log = startEditLog(crlf, 'd0');
    // Backspace at the start of `two`
    log = recordEdit(log, 'one\ntwo\nthree', { start: 4, end: 4 }, 'onetwo\nthree', 3);
    expect(editLogGaps(log)).toEqual([{ start: 3, end: 5, value: '' }]);
    expect(applyTextOps(log.base, log.ops)).toBe('onetwo\r\nthree');
    // and a lone `\r`
    log = startEditLog('one\rtwo', 'd0');
    log = recordEdit(log, 'one\ntwo', { start: 4, end: 4 }, 'onetwo', 3);
    expect(editLogGaps(log)).toEqual([{ start: 3, end: 4, value: '' }]);
  });

  it('sends a typed newline as typed, and keeps every carriage return the user did not delete', () => {
    let log = startEditLog(crlf, 'd0');
    log = recordEdit(log, 'one\ntwo\nthree', { start: 5, end: 5 }, 'one\ntw\no\nthree', 6);
    expect(editLogBody(log)).toBe('one\ntw\no\nthree');
    expect(editLogGaps(log)).toEqual([{ start: 7, end: 7, value: '\n' }]);
    expect(applyTextOps(log.base, log.ops)).toBe('one\r\ntw\no\r\nthree');
    // a newline typed right after a lone `\r` keeps it a line break of its own
    log = startEditLog('a\rb', 'd0');
    log = recordEdit(log, 'a\nb', { start: 2, end: 2 }, 'a\n\nb', 3);
    expect(editLogBody(log)).toBe('a\n\nb');
    const stored = applyTextOps(log.base, log.ops);
    expect(stored.replace(/\r\n?/g, '\n')).toBe('a\n\nb');
    expect(stored.startsWith('a\r')).toBe(true);
    // a letter deleted between a lone `\r` and a `\n` leaves two line breaks
    log = startEditLog('a\rx\nb', 'd0');
    log = recordEdit(log, 'a\nx\nb', { start: 3, end: 3 }, 'a\n\nb', 2);
    const joined = applyTextOps(log.base, log.ops);
    expect(joined.replace(/\r\n?/g, '\n')).toBe('a\n\nb');
    expect(joined.startsWith('a\r')).toBe(true);
  });

  it('sends, rebases and unsends over the stored text', () => {
    let log = startEditLog(crlf, 'd0');
    log = recordEdit(log, 'one\ntwo\nthree', { start: 3, end: 3 }, 'ones\ntwo\nthree', 4);
    const { sent, rest } = sendEditLog(log);
    expect(sent.gaps).toEqual([{ start: 3, end: 3, value: 's' }]);
    expect(rest.base).toBe('ones\r\ntwo\r\nthree');
    expect(editLogBody(rest)).toBe('ones\ntwo\nthree');
    const back = unsendEditLog(sent, rest);
    expect(editLogBody(back)).toBe('ones\ntwo\nthree');
    const moved = rebaseEditLog(log, 'one\r\ntwo\r\nthree!', 'd1');
    expect(moved.base).toBe('one\r\ntwo\r\nthree!');
    expect(editLogBody(moved)).toBe('ones\ntwo\nthree!');
    expect(editLogGaps(moved)).toEqual([{ start: 3, end: 3, value: 's' }]);
  });
});

describe('storedHolds', () => {
  const ins = (start, value) => ({ start, end: start, value });
  it('holds a change the stored text is, or holds with another change beside it', () => {
    expect(storedHolds('the cat sat', [ins(3, ' big')], 'the big cat sat')).toBe(true);
    expect(
      storedHolds('the cat sat on the mat', [ins(3, ' big')], 'the big cat sat on the rug'),
    ).toBe(true);
    expect(storedHolds('the the cat', [{ start: 0, end: 4, value: '' }], 'the cat')).toBe(true);
    expect(storedHolds('the cat', [ins(3, ' the')], 'the the cat')).toBe(true);
  });

  it('does not hold a change the stored text lacks, or one it cannot be told apart from', () => {
    expect(storedHolds('the cat sat', [ins(3, ' big')], 'the cat sat')).toBe(false);
    expect(storedHolds('the cat sat', [ins(3, ' big')], 'the cat sat down')).toBe(false);
    expect(storedHolds('he walkd home', [ins(7, 'e')], 'he walks home')).toBe(false);
    // `the` typed twice where one is stored
    expect(storedHolds('the cat', [ins(3, ' the the')], 'the the cat')).toBe(false);
  });
});
