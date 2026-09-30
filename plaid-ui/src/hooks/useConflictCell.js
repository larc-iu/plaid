import { useEffect, useRef, useState } from 'react';
import { statusOf } from '../lib/errors.js';
import { drawCell, reactCellEngine } from './useCellEngine.js';

// One drawn grid cell on the cell engine (domain/cells/CellEngine.js), for a
// React cell that owns its input: what it shows at rest, the conflict note,
// the value it takes up on focus, and its commit. The cell keeps every input
// mechanic of its own. This hook moves no focus: a refused value goes back
// into the cell only while the cell has focus already.
//
// - `stored`: the value stored now, as the cell's props have it.
// - `editingRef`: true while the cell has focus.
// - `typedRef`: true once something was typed or picked since focus.
// - `setShown(value)`: puts a value in the input.
//
// `engine` null is a cell drawn outside a grid (a test, a preview), which
// gets an engine of its own reading `stored`.
export function useConflictCell(engine, key, { stored, editingRef, typedRef, setShown }) {
  const storedRef = useRef(stored);
  storedRef.current = stored;
  const showRef = useRef(setShown);
  showRef.current = setShown;
  const [loose] = useState(() =>
    engine ? null : reactCellEngine({ read: () => storedRef.current ?? '' }),
  );
  const cells = engine ?? loose;
  const [conflict, setConflict] = useState(() => cells.conflictOf(key));
  // A value put back while the cell was away, `{ typed, saved }`, once focus
  // has taken it up. Leaving the cell sends it.
  const takenRef = useRef(null);
  const untouched = () => !editingRef.current || !typedRef.current;

  useEffect(
    () =>
      drawCell(cells, key, {
        focused: () => editingRef.current,
        typedSince: () => editingRef.current && typedRef.current,
        takeUp: ({ typed, saved }) => {
          if (!editingRef.current) return false;
          takenRef.current = { typed, saved: takenRef.current?.saved ?? saved };
          showRef.current(typed);
          return true;
        },
        showStored: (value) => {
          if (!untouched()) return;
          takenRef.current = null;
          showRef.current(value);
        },
        update: () => {
          setConflict(cells.conflictOf(key));
          if (untouched() && cells.unsentOf(key)) {
            showRef.current(cells.display(key, storedRef.current ?? ''));
          }
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cells, key],
  );

  // Taken up and left while focused (a page turned from the keyboard), the
  // value goes back to wait for the cell to be drawn again.
  useEffect(
    () => () => {
      const taken = takenRef.current;
      if (taken && editingRef.current) cells.release(key, taken.typed, taken.saved);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cells, key],
  );

  // The stored value moved (a save, a reload, another annotator). A value
  // taken up over one that is no longer stored is a conflict. The rest is
  // the engine's to go over, and the cell shows what it holds now unless
  // someone is typing in it.
  useEffect(() => {
    const now = stored ?? '';
    const taken = takenRef.current;
    if (taken && now !== taken.saved) {
      takenRef.current = null;
      cells.conflict(key, taken.typed, now);
    }
    cells.reconcile();
    setConflict(cells.conflictOf(key));
    // A focused cell nobody typed in follows too, or leaving it would write
    // the value it showed back over the new one.
    if (untouched()) showRef.current(cells.display(key, now));
    // Keyed on the stored value alone: the engine and key are the same for as
    // long as the cell is drawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);

  return {
    conflict,
    /** What the cell shows when first drawn. */
    initial: () => cells.display(key, stored ?? ''),
    /** Focus: a value waiting for the cell is taken up. */
    onFocus: () => {
      const taken = cells.focus(key);
      if (taken) takenRef.current = taken;
    },
    /** A typed keystroke lets a conflict go. */
    onTyped: () => {
      if (cells.dismiss(key)) setConflict(null);
    },
    /** Escape lets a conflict go, and a value taken up. */
    onEscape: () => {
      takenRef.current = null;
      if (cells.dismiss(key)) setConflict(null);
    },
    /** Enter with nothing typed on a cell that lost: the refused value, or null. */
    keepYours: () => {
      const typed = cells.keepYours(key);
      if (typed != null) setConflict(null);
      return typed;
    },
    /** Leaving the cell: answers the value taken up on focus, or null. */
    leave: () => {
      const taken = takenRef.current;
      takenRef.current = null;
      return taken;
    },
    /**
     * Send `typed`, typed over `saved`. `write()` answers the write's outcome
     * (DocumentModel.cellWrite). The engine decides what the cell shows if
     * it is refused. Answers the engine's decision.
     */
    commit: (typed, saved, write, meta = {}) => {
      const ticket = cells.sending(key, { saved, typed, ...meta });
      setConflict(null);
      return Promise.resolve()
        .then(write)
        .catch((error) => ({ landed: false, status: statusOf(error), error, readBack: false }))
        .then((outcome) => cells.settle(ticket, outcome ?? { landed: true }));
    },
  };
}
