import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_TABLE,
  composeRows,
  isBuiltInCode,
  readProjectCodes,
  readRemovedCodes,
  resolveComposeTable,
  rowsToConfig,
  shadowsBuiltIn,
  validateCode,
} from './composeConfig.js';
import { composeInsert, lookupCode } from './compose.js';

const withCodes = (codes) => ({ igt: { compose: { codes } } });

// Type a string through the composer against a given table.
const type = (s, table) => {
  let value = '';
  let caret = 0;
  let escapedAt = -1;
  for (const ch of s) {
    const r = composeInsert(value, caret, ch, { escapedAt, table });
    if (r) {
      value = value.slice(0, r.start) + r.text + value.slice(r.end);
      caret = r.start + r.text.length;
      escapedAt = r.escapedAt ?? -1;
    } else {
      value = value.slice(0, caret) + ch + value.slice(caret);
      caret += 1;
    }
  }
  return value;
};

describe('reading a project’s codes', () => {
  it('is empty when the project has none', () => {
    expect(readProjectCodes(undefined)).toEqual([]);
    expect(readProjectCodes({ igt: {} })).toEqual([]);
    expect(readProjectCodes(withCodes([]))).toEqual([]);
  });

  it('drops rows that could not work', () => {
    const rows = readProjectCodes(
      withCodes([
        { code: "b'", char: 'ɓ' }, // fine
        { code: 'b', char: 'ɓ' }, // too short: would shadow every b? code
        { code: 'abc', char: 'x' }, // too long: the scan has no lookahead
        { code: 'zz' }, // types nothing
        null,
      ]),
    );
    expect(rows).toEqual([{ code: "b'", char: 'ɓ' }]);
  });

  it('counts a code in characters, not UTF-16 units', () => {
    // A two-character code where one is astral still counts as two.
    expect(readProjectCodes(withCodes([{ code: 'a\u{1D50A}', char: 'x' }]))).toHaveLength(1);
  });
});

describe('resolving the table', () => {
  it('is the built-in table itself when a project adds nothing', () => {
    expect(resolveComposeTable({ igt: {} })).toBe(BUILT_IN_TABLE);
  });

  it('layers a project code on top without losing the built-ins', () => {
    const table = resolveComposeTable(withCodes([{ code: "b'", char: 'ɓ' }]));
    expect(lookupCode("b'", table)).toBe('ɓ');
    expect(lookupCode('sw', table)).toBe('ə'); // still there
    expect(Object.keys(table).length).toBe(Object.keys(BUILT_IN_TABLE).length + 1);
  });

  it('lets a project rebind a built-in code', () => {
    const table = resolveComposeTable(withCodes([{ code: 'ng', char: 'ŋ̊' }]));
    expect(lookupCode('ng', table)).toBe('ŋ̊');
    expect(lookupCode('ng', BUILT_IN_TABLE)).toBe('ŋ'); // the built-in is untouched
  });

  it('never mutates the built-in table', () => {
    const before = Object.keys(BUILT_IN_TABLE).length;
    resolveComposeTable(withCodes([{ code: 'zz', char: 'Z' }]));
    expect(Object.keys(BUILT_IN_TABLE).length).toBe(before);
    expect(lookupCode('zz', BUILT_IN_TABLE)).toBeNull();
  });
});

describe('a project code in use', () => {
  it('composes like any other', () => {
    const table = resolveComposeTable(withCodes([{ code: "b'", char: 'ɓ' }]));
    expect(type("\\b'a", table)).toBe('ɓa');
  });

  it('does not apply to a project that has not bound it', () => {
    expect(type("\\b'a")).toBe("\\b'a");
  });

  it('leaves the code-point escape alone', () => {
    const table = resolveComposeTable(withCodes([{ code: "b'", char: 'ɓ' }]));
    expect(type('\\u2205', table)).toBe('∅');
  });
});

describe('validateCode', () => {
  const ok = (row, others) => validateCode(row, others).length === 0;

  it('accepts a two-character code that types something', () => {
    expect(ok({ code: "b'", char: 'ɓ' })).toBe(true);
  });

  it('refuses the wrong length, a space, a backslash, and an empty character', () => {
    expect(validateCode({ code: 'b', char: 'ɓ' })[0]).toMatch(/exactly 2/);
    expect(validateCode({ code: 'b ', char: 'ɓ' }).some((p) => /space/.test(p))).toBe(true);
    expect(validateCode({ code: '\\b', char: 'ɓ' }).some((p) => /backslash/.test(p))).toBe(true);
    expect(validateCode({ code: "b'", char: '' }).some((p) => /character/.test(p))).toBe(true);
  });

  it('refuses a duplicate within the project', () => {
    const a = { code: "b'", char: 'ɓ' };
    const b = { code: "b'", char: 'ɗ' };
    expect(validateCode(b, [a, b]).some((p) => /Another code/.test(p))).toBe(true);
    // Against itself alone it is fine.
    expect(ok(a, [a])).toBe(true);
  });
});

describe('shadowsBuiltIn', () => {
  it('knows which codes already mean something', () => {
    expect(shadowsBuiltIn('sw')).toBe(true);
    expect(shadowsBuiltIn("b'")).toBe(false);
  });
});

const BUILT_IN_COUNT = Object.keys(BUILT_IN_TABLE).length;

describe('every code as an editable entry', () => {
  it('lists all the built-ins when a project has changed nothing', () => {
    const rows = composeRows({ igt: {} });
    expect(rows).toHaveLength(BUILT_IN_COUNT);
    expect(rows.every((r) => r.origin === 'built-in')).toBe(true);
    expect(rows.find((r) => r.code === 'sw')).toMatchObject({ char: 'ə' });
  });

  it('shows a changed built-in with its new character', () => {
    const rows = composeRows(withCodes([{ code: 'ng', char: 'ŋ̊', description: 'voiceless' }]));
    expect(rows).toHaveLength(BUILT_IN_COUNT); // still one entry, not two
    expect(rows.find((r) => r.code === 'ng')).toMatchObject({
      char: 'ŋ̊',
      description: 'voiceless',
      origin: 'changed',
    });
  });

  it('keeps a removed built-in in the list so it can be put back', () => {
    const rows = composeRows({ igt: { compose: { removed: ['ng'] } } });
    expect(rows).toHaveLength(BUILT_IN_COUNT);
    expect(rows.find((r) => r.code === 'ng')).toMatchObject({ origin: 'removed', char: 'ŋ' });
  });

  it('adds a project code at the end', () => {
    const rows = composeRows(withCodes([{ code: "b'", char: 'ɓ' }]));
    expect(rows).toHaveLength(BUILT_IN_COUNT + 1);
    expect(rows.at(-1)).toMatchObject({ code: "b'", char: 'ɓ', origin: 'added' });
  });
});

describe('a removed built-in', () => {
  it('is gone from the table', () => {
    const table = resolveComposeTable({ igt: { compose: { removed: ['ng'] } } });
    expect(table.ng).toBeUndefined();
    expect(table.sw).toBe('ə'); // the rest survive
    expect(type('\\ng', table)).toBe('\\ng');
  });

  it('is ignored when it names something that is not built in', () => {
    expect(readRemovedCodes({ igt: { compose: { removed: ["b'", 'ng'] } } })).toEqual(['ng']);
  });

  it('loses to an entry that also changes it', () => {
    // Removing and rebinding the same code is contradictory; the binding wins,
    // which is what the settings screen produces when a row is edited.
    const table = resolveComposeTable({
      igt: { compose: { removed: ['ng'], codes: [{ code: 'ng', char: 'X' }] } },
    });
    expect(table.ng).toBe('X');
  });
});

describe('what gets stored', () => {
  const rowsOf = (config) => composeRows(config);

  it('is nothing at all when no entry was touched', () => {
    expect(rowsToConfig(rowsOf({ igt: {} }))).toEqual({ codes: [], removed: [] });
  });

  it('is only the entries that differ', () => {
    const rows = rowsOf({ igt: {} }).map((r) => (r.code === 'sw' ? { ...r, char: 'Ə' } : r));
    expect(rowsToConfig(rows)).toEqual({ codes: [{ code: 'sw', char: 'Ə' }], removed: [] });
  });

  it('records a removal, and drops it again on reset', () => {
    const rows = rowsOf({ igt: {} }).map((r) =>
      r.code === 'ng' ? { ...r, origin: 'removed' } : r,
    );
    expect(rowsToConfig(rows)).toEqual({ codes: [], removed: ['ng'] });
    const back = rows.map((r) => (r.code === 'ng' ? { ...r, origin: 'built-in' } : r));
    expect(rowsToConfig(back)).toEqual({ codes: [], removed: [] });
  });

  it('round-trips through the config and back to the same entries', () => {
    const edited = rowsOf({ igt: {} })
      .map((r) => (r.code === 'sw' ? { ...r, char: 'Ə', origin: 'changed' } : r))
      .map((r) => (r.code === 'ng' ? { ...r, origin: 'removed' } : r))
      .concat({ code: "b'", char: 'ɓ', description: '', origin: 'added' });
    const stored = rowsToConfig(edited);
    const reread = composeRows({ igt: { compose: stored } });
    expect(reread.find((r) => r.code === 'sw')).toMatchObject({ char: 'Ə', origin: 'changed' });
    expect(reread.find((r) => r.code === 'ng')).toMatchObject({ origin: 'removed' });
    expect(reread.find((r) => r.code === "b'")).toMatchObject({ char: 'ɓ', origin: 'added' });
    expect(reread).toHaveLength(BUILT_IN_COUNT + 1);
  });
});

describe('isBuiltInCode', () => {
  it('separates what ships from what a project added', () => {
    expect(isBuiltInCode('sw')).toBe(true);
    expect(isBuiltInCode("b'")).toBe(false);
  });
});
