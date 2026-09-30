import { expect } from 'vitest';
import { readCell } from './cellReader.js';

// For the component tests: what the cell engine reads under each cell
// (cellReader.js, from the document) is what the grid drew there
// (`igtRendered`, set by uncontrolledValue). The engine decides refusals by
// the first, and the person sees the second.
export const expectIndexMatchesDom = (editor) => {
  if (!editor || editor._destroyed) return;
  const drawn = [...editor.container.querySelectorAll('.igt-field[data-cell-key]')];
  const differ = drawn
    .map((el) => [el.dataset.cellKey, readCell(editor.doc, el.dataset.cellKey), el.igtRendered])
    .filter(([, read, shown]) => read !== shown);
  expect(differ).toEqual([]);
};
