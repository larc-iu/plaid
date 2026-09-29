import { useRef } from 'react';

/**
 * One config cell a page writes more than once without reading it back in
 * between, such as a list edited a row at a time. `stored` is the cell as the
 * page last read it (`storedConfig`). Returns:
 *
 * - `expected()`: what the cell holds as far as this page knows, for a write's
 *   `{ expected }`. That is the page's own last write, until the page reads a
 *   new copy of the cell.
 * - `write(send)`: runs `send(expected)` after the page's earlier writes of
 *   this cell have settled, since a second write sent while the first is on
 *   its way would expect what the first replaced. `send` resolves to the
 *   value it stored. A refused write leaves the expected value as it was.
 */
export function useConfigCell(stored) {
  const ref = useRef(null);
  if (!ref.current) ref.current = { stored, value: stored, turn: Promise.resolve() };
  const cell = ref.current;
  // A new copy of the cell: the page has read it again.
  if (cell.stored !== stored) {
    cell.stored = stored;
    cell.value = stored;
  }
  if (!cell.api) {
    cell.api = {
      expected: () => cell.value,
      write: (send) => {
        const run = cell.turn.then(async () => {
          const value = await send(cell.value);
          cell.value = value;
          return value;
        });
        cell.turn = run.catch(() => {});
        return run;
      },
    };
  }
  return cell.api;
}
