import { useCallback, useMemo, useRef, useState } from 'react';
import {
  editLogCanStep,
  editLogGaps,
  rebaseEditLog,
  recordEdit,
  sendEditLog,
  settleEditLog,
  startEditLog,
  unsendEditLog,
} from '../lib/editLog.js';

/**
 * The edit log (lib/editLog.js) of a controlled textarea. Spread `handlers`
 * on it so the selection before each change is known, and call `onChange`
 * from its change handler (or `record(prev, next, caretAfter, inputType)` for
 * a value that changed some other way). The input event's `inputType` tells
 * an undo, redo or drop, which happen away from the selection before them. A
 * textarea with its own onKeyDown, onSelect, onMouseUp or onFocus calls
 * `capture(event)` from it instead.
 *
 * An undo or redo the log cannot place (it keeps no state with that text: one
 * reaching back before someone else's text was taken in, or past what the log
 * keeps) is refused: cancelled before it happens when the log keeps no state
 * at all, else the box is put back to the text it had, so the undo does
 * nothing. It is never recorded from a guess.
 */
export function useEditLog(base = '', digest = null) {
  const logRef = useRef(null);
  if (logRef.current === null) logRef.current = startEditLog(base, digest);
  const [log, setLog] = useState(logRef.current);
  // the selection before the next change, UTF-16 as the DOM gives it
  const selection = useRef({ start: 0, end: 0 });

  const put = useCallback((next) => {
    logRef.current = next;
    setLog(next);
    return next;
  }, []);

  // the box an undo with nowhere to go is cancelled on
  const guarded = useRef(null);
  const refuse = useCallback((event) => {
    const back = event.inputType === 'historyUndo';
    if (!back && event.inputType !== 'historyRedo') return;
    if (!editLogCanStep(logRef.current, back)) event.preventDefault();
  }, []);

  const capture = useCallback(
    (event) => {
      const el = event?.currentTarget ?? event?.target;
      if (!el || typeof el.selectionStart !== 'number') return;
      selection.current = { start: el.selectionStart, end: el.selectionEnd };
      if (guarded.current !== el && typeof el.addEventListener === 'function') {
        guarded.current?.removeEventListener('beforeinput', refuse);
        el.addEventListener('beforeinput', refuse);
        guarded.current = el;
      }
    },
    [refuse],
  );

  const record = useCallback(
    (prev, next, caretAfter, inputType = null) =>
      put(recordEdit(logRef.current, prev, selection.current, next, caretAfter, inputType)),
    [put],
  );

  const onChange = useCallback(
    (event) => {
      const el = event.target;
      const caret = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
      const before = selection.current;
      const now = record(
        logRef.current.body,
        el.value,
        caret,
        event.nativeEvent?.inputType ?? null,
      );
      if (now.body !== el.value) {
        // refused: the box goes back to the text the log makes, before the
        // change handler reads it
        el.value = now.body;
        const end = Math.min(before.end, el.value.length);
        el.setSelectionRange(Math.min(before.start, end), end);
      }
      capture(event);
    },
    [record, capture],
  );

  const handlers = useMemo(
    () => ({ onSelect: capture, onKeyDown: capture, onMouseUp: capture, onFocus: capture }),
    [capture],
  );

  return {
    log,
    handlers,
    capture,
    onChange,
    record,
    /** Start again over `nextBase`, whose digest is `nextDigest`. */
    reset: useCallback(
      (nextBase, nextDigest = null) => put(startEditLog(nextBase, nextDigest)),
      [put],
    ),
    /** The net change, as gaps of the log's base. */
    gaps: useCallback(() => editLogGaps(logRef.current), []),
    /** Move the log onto `stored`. Answers the new log, or `{ conflict: true }` and keeps the log. */
    rebase: useCallback(
      (stored, storedDigest = null) => {
        const moved = rebaseEditLog(logRef.current, stored, storedDigest);
        return moved.conflict ? moved : put(moved);
      },
      [put],
    ),
    /** Split the log at a send: answers what to send, and keeps logging after it. */
    send: useCallback(() => {
      const { sent, rest } = sendEditLog(logRef.current);
      put(rest);
      return sent;
    }, [put]),
    /** The send landed: the log's base now has `landedDigest`. */
    settle: useCallback((landedDigest) => put(settleEditLog(logRef.current, landedDigest)), [put]),
    /** The send did not land: its gaps go back in front of what was typed since. */
    unsend: useCallback((sent) => put(unsendEditLog(sent, logRef.current)), [put]),
  };
}
