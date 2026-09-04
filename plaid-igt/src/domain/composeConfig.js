// A project's own compose codes, layered over the built-in Praat table.
//
// WHY LAYERED, and not a copy of the defaults the project then edits. A copy
// would put ~440 rows in every project's config, freeze each project at the
// table it was created with, and make the settings screen a four-hundred-row
// editor. Layering gives the same thing a person sees ("the Praat codes work,
// and I can add my own or change one") while a project that binds two codes
// stores two rows. To change a built-in code, bind the same code to something
// else: the project's binding wins.
//
// A project code is EXACTLY TWO CHARACTERS, like every built-in one. That is
// not a formality: it is what makes the whole set prefix-free, so the scanner
// in compose.js can decide at each keystroke without lookahead. A one-character
// code would shadow every built-in code starting with that letter.

import { COMPOSE_TABLE } from './composeTable.js';
import { CODE_LENGTH } from './compose.js';
import { readCompose } from './igtConfig.js';

/** The built-in codes, as shipped. */
export const BUILT_IN_TABLE = COMPOSE_TABLE;

/** How many characters a code must be. */
export { CODE_LENGTH };

const isFilledString = (v) => typeof v === 'string' && v.length > 0;

/** A project's own code rows, cleaned of anything unusable. Never null. */
export function readProjectCodes(projectConfig) {
  const rows = readCompose(projectConfig)?.codes;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (r) => r && [...(r.code ?? '')].length === CODE_LENGTH && isFilledString(r.char),
  );
}

/**
 * The table the composer should use for this project: the built-in codes with
 * the project's own layered on top. Returns the built-in table itself when the
 * project adds nothing, so the common case allocates nothing.
 */
export function resolveComposeTable(projectConfig) {
  const rows = readProjectCodes(projectConfig);
  if (rows.length === 0) return BUILT_IN_TABLE;
  const table = { ...BUILT_IN_TABLE };
  for (const r of rows) table[r.code] = r.char;
  return table;
}

/**
 * What is wrong with one row, as a list of reasons the settings screen can
 * show. `others` are the project's other rows, for the duplicate check.
 */
export function validateCode(row, others = []) {
  const problems = [];
  const code = row?.code ?? '';
  const chars = [...code];
  if (chars.length !== CODE_LENGTH) {
    problems.push(`A code is exactly ${CODE_LENGTH} characters.`);
  }
  if (/\s/.test(code)) problems.push('A code cannot contain a space.');
  if (code.includes('\\')) problems.push('A code cannot contain a backslash.');
  if (!isFilledString(row?.char)) problems.push('Give the character this code types.');
  if (others.some((o) => o !== row && o.code === code && code !== '')) {
    problems.push('Another code in this project is the same.');
  }
  return problems;
}

/** Does this project code replace a built-in one? */
export const shadowsBuiltIn = (code) => Object.prototype.hasOwnProperty.call(BUILT_IN_TABLE, code);
