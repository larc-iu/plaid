import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordEdit, sendEditLog, startEditLog, unsendEditLog } from './editLog.js';

// H31-TEXT-1: a save on a long text split the whole body into code points
// once for each kept undo state, about 400 times, and blocked the page for
// over half a second. The body is now split once per change of body.
describe('edit log on a long body', () => {
  const iterate = String.prototype[Symbol.iterator];
  let longSpreads = 0;
  beforeEach(() => {
    longSpreads = 0;
    String.prototype[Symbol.iterator] = function count() {
      if (this.length > 50000) longSpreads += 1;
      return iterate.call(this);
    };
  });
  afterEach(() => {
    String.prototype[Symbol.iterator] = iterate;
  });

  it('splits the body a few times per save, not once per kept state', () => {
    const base = 'tok \u{1D52E}a wə. '.repeat(6000);
    let log = startEditLog(base, 'd0');
    let box = base;
    let at = Math.floor(box.length / 2);
    for (let i = 0; i < 250; i += 1) {
      const next = `${box.slice(0, at)}a${box.slice(at)}`;
      log = recordEdit(log, box, { start: at, end: at }, next, at + 1, 'insertText');
      box = next;
      at += 1;
    }
    expect(log.past.length).toBe(200);

    longSpreads = 0;
    const { sent, rest } = sendEditLog(log);
    expect(longSpreads).toBeLessThan(10);
    expect(rest.body).toBe(box);

    longSpreads = 0;
    const back = unsendEditLog(sent, rest);
    expect(longSpreads).toBeLessThan(10);
    expect(back.body).toBe(box);

    // an undo after the refused save still reaches the state before
    const prev = `${box.slice(0, at - 1)}${box.slice(at)}`;
    const undone = recordEdit(back, box, { start: at, end: at }, prev, at - 1, 'historyUndo');
    expect(undone.body).toBe(prev);
  });
});
