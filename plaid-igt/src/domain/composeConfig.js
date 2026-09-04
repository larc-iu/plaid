// A project's compose codes: every built-in code is an entry the project can
// change or remove, plus any codes it adds of its own.
//
// WHAT IS STORED IS A DIFF, not a copy of the table. The settings screen shows
// all ~440 codes as editable entries, but a project that changes two of them
// stores two rows and a project that changes none stores nothing. That keeps a
// project from freezing at whatever the table looked like the day it was made:
// a code nobody touched still picks up a correction. Nothing about the diff is
// visible to the person editing, who sees one list of entries.
//
// A code is EXACTLY TWO CHARACTERS, built-in or added. That is not a formality:
// it is what makes the whole set prefix-free, so the scan in compose.js can
// decide at each keystroke without lookahead. A one-character code would shadow
// every code starting with that letter.

import { COMPOSE_TABLE } from './composeTable.js';
import { CODE_LENGTH } from './compose.js';
import { readCompose } from './igtConfig.js';

/** The codes as shipped, before a project changes anything. */
export const BUILT_IN_TABLE = COMPOSE_TABLE;

/** How many characters a code must be. */
export { CODE_LENGTH };

const isFilledString = (v) => typeof v === 'string' && v.length > 0;
const isCode = (v) => typeof v === 'string' && [...v].length === CODE_LENGTH;

/** Is this one of the codes that ships with the app? */
export const isBuiltInCode = (code) => Object.prototype.hasOwnProperty.call(BUILT_IN_TABLE, code);

/** Kept for callers that ask the older question. */
export const shadowsBuiltIn = isBuiltInCode;

/** The project's changed and added entries. Never null. */
export function readProjectCodes(projectConfig) {
  const rows = readCompose(projectConfig)?.codes;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => r && isCode(r.code) && isFilledString(r.char));
}

/** Built-in codes this project has taken out. Never null. */
export function readRemovedCodes(projectConfig) {
  const rows = readCompose(projectConfig)?.removed;
  if (!Array.isArray(rows)) return [];
  return rows.filter((c) => isCode(c) && isBuiltInCode(c));
}

/**
 * The table the composer should use: the built-in codes, minus the ones this
 * project removed, plus the ones it changed or added. Returns the built-in
 * table itself when a project has changed nothing, so the common case
 * allocates nothing.
 */
export function resolveComposeTable(projectConfig) {
  const codes = readProjectCodes(projectConfig);
  const removed = readRemovedCodes(projectConfig);
  if (codes.length === 0 && removed.length === 0) return BUILT_IN_TABLE;
  const table = { ...BUILT_IN_TABLE };
  for (const c of removed) delete table[c];
  for (const r of codes) table[r.code] = r.char;
  return table;
}

/**
 * Every code as one editable entry, which is what the settings screen edits:
 * the built-ins with this project's changes already applied, then anything the
 * project added. `origin` says where a row came from and how it differs, so the
 * screen can offer Reset on exactly the rows that have something to reset.
 *
 *   built-in  as shipped
 *   changed   a built-in code this project points somewhere else
 *   removed   a built-in code this project took out
 *   added     a code that is not built in at all
 */
export function composeRows(projectConfig) {
  const overrides = new Map(readProjectCodes(projectConfig).map((r) => [r.code, r]));
  const removed = new Set(readRemovedCodes(projectConfig));
  const rows = Object.entries(BUILT_IN_TABLE).map(([code, char]) => {
    const over = overrides.get(code);
    if (removed.has(code)) return { code, char, description: '', origin: 'removed' };
    if (over) {
      return {
        code,
        char: over.char,
        description: over.description || '',
        origin: 'changed',
      };
    }
    return { code, char, description: '', origin: 'built-in' };
  });
  for (const [code, r] of overrides) {
    if (isBuiltInCode(code)) continue;
    rows.push({ code, char: r.char, description: r.description || '', origin: 'added' });
  }
  return rows;
}

/** What a row looks like as shipped, or null when it is not a built-in code. */
export const builtInRow = (code) =>
  isBuiltInCode(code) ? { code, char: BUILT_IN_TABLE[code], description: '' } : null;

/** Has this row been changed from what ships? */
export const isRowDirty = (row) => {
  if (!isBuiltInCode(row.code)) return true;
  if (row.origin === 'removed') return true;
  return row.char !== BUILT_IN_TABLE[row.code] || !!row.description;
};

/**
 * Turn the edited entry list back into the diff that gets stored. Rows equal
 * to what ships contribute nothing.
 */
export function rowsToConfig(rows) {
  const codes = [];
  const removed = [];
  for (const row of rows) {
    if (row.origin === 'removed') {
      if (isBuiltInCode(row.code)) removed.push(row.code);
      continue;
    }
    if (!isRowDirty(row)) continue;
    codes.push(
      row.description
        ? { code: row.code, char: row.char, description: row.description }
        : { code: row.code, char: row.char },
    );
  }
  return { codes, removed };
}

/**
 * What is wrong with one row, as a list of reasons the settings screen can
 * show. `others` are the other rows, for the duplicate check.
 */
export function validateCode(row, others = []) {
  const problems = [];
  const code = row?.code ?? '';
  if (row?.origin === 'removed') return problems;
  if ([...code].length !== CODE_LENGTH) {
    problems.push(`A code is exactly ${CODE_LENGTH} characters.`);
  }
  if (/\s/.test(code)) problems.push('A code cannot contain a space.');
  if (code.includes('\\')) problems.push('A code cannot contain a backslash.');
  if (!isFilledString(row?.char)) problems.push('Give the character this code types.');
  if (others.some((o) => o !== row && o.code === code && o.origin !== 'removed' && code !== '')) {
    problems.push('Another code is already this.');
  }
  return problems;
}
