import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import FOLDS from './javaCaseFolds.js';
import { translatePattern, SERVER_PATTERN_MAX } from './javaRegex.js';

const W = '[\\p{L}\\p{M}\\p{Nd}\\p{Pc}]';

const tr = (p, o) => translatePattern(p, o);

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

  it('writes a letter in any case as the letters Java folds it with, and no flag', () => {
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

  it('refuses a pattern longer than the server takes', () => {
    const long = 'a'.repeat(SERVER_PATTERN_MAX + 1);
    expect(tr(long).error).toBe('The pattern is too long.');
    expect(tr('a'.repeat(200), { literal: true, caseInsensitive: true }).error).toBe(
      'The pattern is too long.',
    );
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
    const lines = [];
    for (const t of translated) for (const s of subjects) lines.push(`${hex(t.server)}\t${hex(s)}`);
    // Vitest runs from the package root.
    const tool = path.resolve('tools/JavaRegex.java');
    const out = execFileSync('java', [tool, 'oracle'], {
      input: `${lines.join('\n')}\n`,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    })
      .trim()
      .split('\n');
    expect(out).toHaveLength(lines.length);
    const differ = [];
    let k = 0;
    for (const t of translated) {
      const re = new RegExp(t.source, 'u');
      for (const s of subjects) {
        const java = out[k++];
        const js = re.test(s) ? '1' : '0';
        if (java !== js) differ.push({ pattern: t.p, opts: t.opts, value: s, java, js });
      }
    }
    expect(differ.slice(0, 10)).toEqual([]);
  }, 120_000);
});
