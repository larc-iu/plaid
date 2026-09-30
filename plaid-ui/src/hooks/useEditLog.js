import { useCallback, useMemo, useRef, useState } from 'react';
import {
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
 * from its change handler (or `record(prev, next, caretAfter)` for a value
 * that changed some other way). A textarea with its own onKeyDown, onSelect,
 * onMouseUp or onFocus calls `capture(event)` from it instead.
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

  const capture = useCallback((event) => {
    const el = event?.currentTarget ?? event?.target;
    if (!el || typeof el.selectionStart !== 'number') return;
    selection.current = { start: el.selectionStart, end: el.selectionEnd };
  }, []);

  const record = useCallback(
    (prev, next, caretAfter) =>
      put(recordEdit(logRef.current, prev, selection.current, next, caretAfter)),
    [put],
  );

  const onChange = useCallback(
    (event) => {
      const el = event.target;
      const caret = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
      record(logRef.current.body, el.value, caret);
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
