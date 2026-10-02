import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import FOLDS from './javaCaseFolds.js';
import { translatePattern, SERVER_PATTERN_MAX } from './javaRegex.js';

const W = '[\\p{L}\\p{M}\\p{Nd}\\p{Pc}]';

// Every server pattern ends in a never-matching branch holding one character
// outside the BMP, which puts Java's lookbehinds on code points (REV-W2 F2).
// The cases below read what comes before it.
const S = `(?:(?!)${String.fromCodePoint(0x10ffff)})?`;
const tr = (p, o) => {
  const t = translatePattern(p, o);
  if (t.server === null) return t;
  expect(t.server.endsWith(S)).toBe(true);
  return { ...t, server: t.server.slice(0, -S.length) };
};

describe('translatePattern', () => {
  it('sends plain text as it is', () => {
    expect(tr('^nac')).toEqual({ server: '^nac', source: '^nac', error: null });
    expect(tr('(a)(b)').server).toBe('(a)(b)');
  });

  it('writes out what the two engines read differently', () => {
    // A word character in any script (ruled 2026-10-02).
    expect(tr('\\w').server).toBe(W);
    expect(tr('\\W').server).toBe('[^\\p{L}\\p{M}\\p{Nd}\\p{Pc}]');
    expect(tr('\\d').server).toBe('\\p{Nd}');
    expect(tr('\\s').server).toBe('[\\x09-\\x0d\\x20]');
    expect(tr('.').server).toBe('[^\\x0a\\x0d\\x{85}\\x{2028}\\x{2029}]');
    expect(tr('.').source).toBe('[^\\x0a\\x0d\\u{85}\\u{2028}\\u{2029}]');
    expect(tr('a$').server).toBe('a(?=(?:\\x0d\\x0a|[\\x0a\\x0d\\x{85}\\x{2028}\\x{2029}])?\\z)');
    expect(tr('\\bx').server).toBe(`(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))x`);
  });

  it('writes a letter in any case as the letters it folds with, and no flag', () => {
    expect(tr('k', { literal: true, caseInsensitive: true }).server).toBe('[Kk\u212a]');
    expect(tr('(?i)k').server).toBe('[Kk\u212a]');
    expect(tr('(?i)[a-c]').server).toBe('[A-Ca-c]');
    expect(tr('(?i)\\w').server).toBe(W);
    expect(tr('a(?i)b(?-i)c').server).toBe('a[Bb]c');
    expect(tr('(?i:a)b').server).toBe('(?:[Aa])b');
  });

  it('reads a literal as text, and whole as the whole value', () => {
    expect(tr('?a.', { literal: true }).server).toBe('\\x3fa\\x2e');
    expect(tr('a|b', { whole: true }).server).toBe('^(?:a|b)\\z');
    expect(tr('a|b', { whole: true }).source).toBe('^(?:a|b)$');
  });

  it('keeps the groups in their order, for $1 in the replacement', () => {
    const { source } = tr('(?<x>a)(?:b)(c)\\1');
    expect('abca'.replace(new RegExp(source, 'u'), '$1$2$<x>')).toBe('aca');
  });

  it('refuses what it cannot read the way the server does, saying what', () => {
    const refused = {
      '[[:alpha:]]': 'Nested [...] is not supported. Write \\[ for a [.',
      '[a&&b]': '&& in [...] is not supported.',
      '\\p{IsLatin}': '\\p{IsLatin} is not supported. Use a category such as \\p{L}.',
      '\\p{Alpha}': '\\p{Alpha} is not supported. Use a category such as \\p{L}.',
      '(?m)^a': '(?m) is not supported.',
      'a*+': 'Possessive quantifiers (*+, ++, ?+) are not supported.',
      '(?>a)': '(?>...) is not supported.',
      '\\G': '\\G is not supported.',
      '\\B': '\\B is not supported.',
      '[\\W]': '\\W is not supported in [...]. Use [^\\w...] instead.',
      '(a)?\\1': '\\1 must refer to a group that always matches before it.',
      '(?:(a)|b)\\1': '\\1 must refer to a group that always matches before it.',
      '(?i)(a)\\1': 'A back reference cannot be used with (?i).',
      '(?i)\\p{Lu}': '\\p{Lu} cannot be used with (?i).',
      '(?<=a*)b': 'A lookbehind must have a bounded length.',
      '*a': 'Nothing to repeat before *. Write \\* for the character.',
      'a{': 'Write \\{ for a {.',
      '(a': 'Unclosed group.',
      'a)': 'Unmatched ).',
      '[a': 'Unclosed [.',
      '[z-a]': 'z-a is not a range.',
      'a{3,2}': 'In {3,2} the first number is larger.',
      '\\': 'The pattern ends with a backslash.',
    };
    for (const [p, message] of Object.entries(refused)) {
      expect([p, tr(p).error]).toEqual([p, message]);
      expect(tr(p).server).toBeNull();
    }
  });

  // The server's cap is core's plaid.query.clauses/regex-max-len. The client
  // refuses first, so a cap left behind here is the one that holds.
  it("takes the server's own cap", () => {
    const clauses = readFileSync(
      path.resolve('../plaid-core/src/main/plaid/query/clauses.clj'),
      'utf8',
    );
    const [, cap] = clauses.match(/\(def regex-max-len (\d+)\)/);
    expect(SERVER_PATTERN_MAX).toBe(Number(cap));
    expect(tr('\\bko\\b|\\bka\\b|\\bta\\b').error).toBeNull();
  });

  it('refuses a pattern longer than the server takes', () => {
    const long = 'a'.repeat(SERVER_PATTERN_MAX + 1);
    expect(tr(long).error).toBe('The pattern is too long.');
    expect(
      tr('a'.repeat(SERVER_PATTERN_MAX / 4), { literal: true, caseInsensitive: true }).error,
    ).toBe('The pattern is too long.');
  });
});

// The property the whole module is for: for every pattern and every value,
// the server's engine finds a match with `server` exactly when the browser's
// finds one with `source`. Java answers through tools/JavaRegex.java, the same
// Pattern.compile and find the server's REGEXP function runs.
describe('translatePattern against Java itself', () => {
  const subjects = [
    ...[
      'Kalamang',
      'KALAMANG',
      'kĭkoⁿtu´',
      'ayiⁿdŭko´',
      'du\u0306ko',
      'ko',
      'koko',
      'a\n',
      'a\r\n',
      'a\r',
      'a\u0085',
      'a\u2028',
      'ab\n',
      '\n',
      '',
      'x',
      '_',
      'a b',
      'a\u00a0b',
      'a\tb',
      'x\u000bx',
      '٣',
      '😀',
      'a😀b',
      'aa',
      'abab',
      'ka-t',
      'ba-ba',
      'ba-bo',
      'a.b',
      'a$b',
      '[x]',
      '{x}',
      'a|b',
      '?a',
      '?',
      'é',
      'e\u0301',
      'x\u200by',
      'x\u3000y',
      'Цвез',
      'цвез',
      'ЦӀуьд',
      'ñaa',
      // Outside the BMP: Adlam, CJK Extension B, Osage. Java's lookbehind
      // stepped back one UTF-16 unit and \b read them otherwise (REV-W2 F2).
      '\u{1e900}x',
      'a\u{1e900}\u{1e901}x',
      '\u{1e900}\u{1e901} \u{1e902}',
      '\u{20000}x',
      'x\u{20000}',
      '\u{104b0}\u{104d8}',
      'Ñu',
      'ə\u0301mə',
      'اَتےِ',
      'sbj:3.PFV',
      '12',
      'a\u0000b',
      'x\u0085',
    ],
    ...FOLDS.flatMap((cls) => Array.from(cls)),
  ];
  const patterns = [
    '\\p{L}',
    '\\p{Lu}',
    '\\pL',
    '\\p{IsL}',
    '\\p{gc=Lu}',
    '\\P{L}',
    '[\\p{L}\\d]',
    '[^\\p{L}]',
    '\\p{M}',
    '\\p{N}',
    '\\p{P}',
    '\\p{Z}',
    '\\p{C}',
    '\\bko\\b',
    '\\bx',
    'x\\b',
    '\\b\\w+\\b',
    '(?<=\\p{L})x',
    '(?<!\\p{L})x',
    '(?<=\\w)',
    '\\b',
    '^\\w+$',
    '\\w',
    '\\W',
    '\\d',
    '\\D',
    '\\s',
    '\\S',
    '\\h',
    '\\H',
    '\\v',
    '\\V',
    '.$',
    '\\w+$',
    'a$',
    '^$',
    'a\\Z',
    'a\\z',
    '\\Aa',
    '.',
    '^.$',
    '(?s)^.$',
    '(?s:a.)',
    '(?i)a',
    '(?i)k',
    '(?i)s',
    '(?i)i',
    '(?i)ß',
    '(?i)ẞ',
    '(?i)σ',
    '(?i)ǆ',
    '(?i)[a-z]',
    '(?i)[^a-z]',
    '(?iu)ц',
    'a(?i)b',
    '((?i)a)b',
    '(?i)\\w',
    '(?i)µ',
    '(?i)θ',
    '(?i)å',
    '(a)\\1',
    '(\\w+)-\\1',
    '(?<x>ba)-\\k<x>',
    'a{2}',
    'a{1,2}',
    'a+?',
    '(?:ab|ba)+',
    '[a-c]',
    '[^a-c]',
    '[-a]',
    '[a-]',
    '[\\]]',
    '[\\w-]',
    '[.]',
    '\\$',
    '\\.',
    '\\Qa.b\\E',
    '\\x41',
    '\\x{1F600}',
    '\\uD83D\\uDE00',
    '\\0101',
    '\\cA',
    ']',
    '}',
    '(?=a)a',
    '(?!a).',
    '(?<=a)b',
    '(?<!a)b',
    '(?<=\\ba)b',
    '(?<=a|bc)d',
    '\\bتے\\b',
    '\\bə\u0301mə\\b',
    '[\\w-]+',
    '\\d+',
    '[^\\w]',
    '\\bцу',
    'ا\\b',
    '[\\p{Lu}\\p{Nd}]',
    '\\p{Ll}\\p{Lu}',
  ];
  const cases = [
    ...patterns.map((p) => ({ p, opts: {} })),
    ...['ka', 'KA', '?a', 'ß', 'ẞ', 'ﬀ', 'ı', 'ǆ', 'ц', 'Ω'].map((p) => ({
      p,
      opts: { literal: true, caseInsensitive: true },
    })),
    { p: 'ka', opts: { literal: true, caseInsensitive: true, whole: true } },
    { p: 'a+', opts: { whole: true } },
  ];

  it('finds a match exactly where Java does', () => {
    const translated = cases.map(({ p, opts }) => ({ p, opts, ...translatePattern(p, opts) }));
    for (const t of translated) expect([t.p, t.error]).toEqual([t.p, null]);
    const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
    // Vitest runs from the package root.
    const tool = path.resolve('tools/JavaRegex.java');
    const java = (lines) =>
      execFileSync('java', [tool, 'oracle'], {
        input: `${lines.join('\n')}\n`,
        encoding: 'utf8',
        maxBuffer: 1 << 26,
      })
        .trim()
        .split('\n');
    // A character newer than the server's Java's Unicode tables is a known
    // difference (the header says so): leave out what Java reads as unassigned.
    const assigned = java(subjects.map((s) => `${hex('\\p{Cn}')}\t${hex(s)}`));
    const known = subjects.filter((s, i) => assigned[i] === '0');
    expect(known.length).toBeGreaterThan(subjects.length * 0.9);
    const lines = [];
    for (const t of translated) for (const s of known) lines.push(`${hex(t.server)}\t${hex(s)}`);
    const out = java(lines);
    expect(out).toHaveLength(lines.length);
    const differ = [];
    let k = 0;
    for (const t of translated) {
      const re = new RegExp(t.source, 'u');
      for (const s of known) {
        const server = out[k++];
        const js = re.test(s) ? '1' : '0';
        if (server !== js) differ.push({ pattern: t.p, opts: t.opts, value: s, java: server, js });
      }
    }
    expect(differ.slice(0, 10)).toEqual([]);
  }, 120_000);
});
