// Delimited text (CSV, TSV) as rows of cells, for igt's CLDF reader and
// vocabulary bulk import, and the tables an assistant conversation export shows.

/**
 * Split delimited text into rows of cells. Quoting follows RFC 4180 (a quote
 * only opens at the start of a cell, "" is a literal quote), which our own TSV
 * export never needs but Excel's "tab delimited" save does. Rows whose cells
 * are all blank are dropped, so a trailing newline or a blank separator line
 * doesn't show up as an empty entry, unless `keepBlank` asks for them.
 *
 * @returns {{cells: string[], line: number}[]} line is the row's 1-based number
 *   as a spreadsheet shows it: blank lines count, and a line break inside a
 *   quoted cell does not start a row.
 */
export const parseDelimited = (text, delimiter, { keepBlank = false } = {}) => {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let cells = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;

  const endRow = () => {
    cells.push(cell);
    cell = '';
    if (keepBlank || cells.some((c) => c.trim() !== '')) rows.push({ cells, line: rowLine });
    cells = [];
    line += 1;
    rowLine = line;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n') {
      endRow();
    } else if (ch === '\r') {
      if (src[i + 1] === '\n') i++; // CRLF
      endRow();
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || cells.length) endRow();
  return rows;
};
