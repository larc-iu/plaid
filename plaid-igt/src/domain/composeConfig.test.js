import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_TABLE,
  readProjectCodes,
  resolveComposeTable,
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
