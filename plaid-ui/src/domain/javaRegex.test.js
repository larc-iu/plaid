import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import FOLDS from './javaCaseFolds.js';
import { translatePattern, SERVER_PATTERN_MAX } from './javaRegex.js';

// Java's Unicode \w (UNICODE_CHARACTER_CLASS), as the server reads it.
const W = '[\\x{200c}\\x{200d}\\p{IsAlphabetic}\\p{M}\\p{Nd}\\p{Pc}]';
const WJS = '[\\u{200c}\\u{200d}\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}]';
const at = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const TOOL = at('../../tools/JavaRegex.java');
const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
// The server's engine: Pattern.compile with UNICODE_CHARACTER_CLASS, then
// find, for lines of `<pattern hex>\t<subject hex>`.
const java = (lines) =>
  execFileSync('java', [TOOL, 'oracle'], {
    input: `${lines.join('\n')}\n`,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
    .trim()
    .split('\n');

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
    // A word character in any script, as the server reads \w (ruled 2026-10-02).
    expect(tr('\\w').server).toBe(W);
    expect(tr('\\w').source).toBe(WJS);
    expect(tr('\\W').server).toBe(`[^${W.slice(1)}`);
    expect(tr('\\d').server).toBe('\\p{Nd}');
    expect(tr('\\s').server).toBe(
      '[\\x09-\\x0d\\x20\\x{85}\u00a0\u1680\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}]',
    );
    expect(tr('(?U)\\w').server).toBe(W);
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

  it('reads a script by any name Java takes, and writes it as JS and Java both read it', () => {
    for (const p of [
      '\\p{IsArabic}',
      '\\p{IsArab}',
      '\\p{Isarabic}',
      '\\p{sc=Arabic}',
      '\\p{script=ARABIC}',
      '\\p{Script=Arab}',
    ])
      expect([p, tr(p).server, tr(p).source]).toEqual([p, '\\p{sc=Arabic}', '\\p{sc=Arabic}']);
    expect(tr('\\P{IsOld_Italic}').server).toBe('\\P{sc=Old_Italic}');
    expect(tr('\\p{IsSignWriting}').source).toBe('\\p{sc=SignWriting}');
    expect(tr('[\\p{IsHan}x]').server).toBe('[x\\p{sc=Han}]');
    expect(tr('\\p{IsL}').server).toBe('\\p{L}');
    expect(tr('\\p{GC=Lu}').server).toBe('\\p{Lu}');
    // A script is not a cased category, so (?i) leaves it as it is.
    expect(tr('(?i)\\p{IsGreek}').server).toBe('\\p{sc=Greek}');
  });

  it('reads a count as a count, with nothing after it', () => {
    expect(tr('a{2}').server).toBe('a{2}');
    expect(tr('a{1,2}?b').server).toBe('a{1,2}?b');
    expect(tr('^x{2,}$').source).toBe(
      '^x{2,}(?=(?:\\x0d\\x0a|[\\x0a\\x0d\\u{85}\\u{2028}\\u{2029}])?$)',
    );
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
      '\\p{InCyrillic}':
        '\\p{InCyrillic} is a block, which is not supported. Use a script such as \\p{IsCyrillic}.',
      '\\p{blk=Cyrillic}':
        '\\p{blk=Cyrillic} is a block, which is not supported. Use a script such as \\p{IsCyrillic}.',
      '\\p{Alpha}':
        '\\p{Alpha} is not supported. Use a category such as \\p{L} or a script such as \\p{IsArabic}.',
      '\\p{Arabic}':
        '\\p{Arabic} is not supported. Use a category such as \\p{L} or a script such as \\p{IsArabic}.',
      '\\p{IsAlphabetic}':
        '\\p{IsAlphabetic} is not supported. Use a category such as \\p{L} or a script such as \\p{IsArabic}.',
      '\\p{IsUnknown}':
        '\\p{IsUnknown} is not supported. Use a category such as \\p{L} or a script such as \\p{IsArabic}.',
      '\\p{scx=Arabic}':
        '\\p{scx=Arabic} is not supported. Use a category such as \\p{L} or a script such as \\p{IsArabic}.',
      '\\p{javaLowerCase}':
        '\\p{javaLowerCase} is not supported. Use a category such as \\p{L} or a script such as \\p{IsArabic}.',
      '(?m)^a': '(?m) is not supported.',
      '(?-U)a': '(?-U) is not supported.',
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
      at('../../../plaid-core/src/main/plaid/query/clauses.clj'),
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
// Pattern.compile (with UNICODE_CHARACTER_CLASS) and find the server's REGEXP
// function runs.
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
      // Java's Unicode \w and \s: a joiner inside a Persian word, a letter
      // number, an alphabetic symbol, other spaces.
      'می\u200cخواهم',
      'x\u200dy',
      'Ⅶ',
      'Ⓐb',
      '\u0345',
      'a\u202fb',
      'a\u2007b',
      'x\u180ey',
      'x\u200by',
      // Several scripts, with their marks and digits.
      'الكتاب',
      'Цвет',
      '汉字',
      'हिन्दी',
      '१२',
      'שָׁלוֹם',
      'Ελληνικά',
      'ქართული',
      'ሰላም',
      'ไทย',
      'カタカナ',
      'ひらがな',
      'ㄅㄆ',
      'Ꭰꭰ',
      '\u{1e950}',
      'abc١',
      'ⁿ',
      '´',
      'ǅ',
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
    // Scripts, by every spelling Java takes.
    '\\p{IsArabic}',
    '^\\p{IsArabic}+$',
    '\\p{IsCyrillic}',
    '^\\p{IsHan}+$',
    '\\p{sc=Devanagari}',
    '\\P{script=Latin}',
    '[\\p{IsGreek}\\p{IsCyrillic}]',
    '[^\\p{IsLatin}\\s]',
    '\\p{IsCommon}',
    '\\p{IsInherited}',
    '^\\p{IsArab}\\p{M}*$',
    '\\p{IsHebrew}+',
    '\\p{IsAdlam}',
    // Java's Unicode classes on several scripts.
    '^[\\w\\s]+$',
    '\\S+',
    '^\\s$',
    '\\b\\w',
    '^\\W+$',
    '\\w\\b',
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

  // A character newer than the server's Java's Unicode tables is a known
  // difference (the header says so): leave out what Java reads as unassigned.
  let known;
  const knownSubjects = () => {
    if (!known) {
      const assigned = java(subjects.map((s) => `${hex('\\p{Cn}')}\t${hex(s)}`));
      known = subjects.filter((s, i) => assigned[i] === '0');
    }
    return known;
  };

  // Java's answer for each pattern on each subject, against the browser's.
  const differences = (rows) => {
    const subjectsKnown = knownSubjects();
    const lines = [];
    for (const r of rows) for (const s of subjectsKnown) lines.push(`${hex(r.java)}\t${hex(s)}`);
    const out = java(lines);
    expect(out).toHaveLength(lines.length);
    const differ = [];
    let k = 0;
    for (const r of rows) {
      const re = new RegExp(r.source, 'u');
      for (const s of subjectsKnown) {
        const server = out[k++];
        const js = re.test(s) ? '1' : '0';
        if (server !== js) differ.push({ pattern: r.p, opts: r.opts, value: s, java: server, js });
      }
    }
    return differ;
  };

  it('finds a match exactly where Java does', () => {
    const translated = cases.map(({ p, opts }) => ({ p, opts, ...translatePattern(p, opts) }));
    for (const t of translated) expect([t.p, t.error]).toEqual([t.p, null]);
    expect(knownSubjects().length).toBeGreaterThan(subjects.length * 0.9);
    expect(differences(translated.map((t) => ({ ...t, java: t.server })))).toEqual([]);
  }, 120_000);

  // What a script sends the API is the typed pattern itself, and the server
  // reads it with UNICODE_CHARACTER_CLASS. The translation must find what that
  // finds, so \w, \d, \s, \b and the scripts read the same in an app's box
  // as from a script. The one reading left apart on purpose is (?i), where
  // Java folds İ and ı with i (ruled 2026-10-02), so a case-insensitive
  // pattern is not compared here. The never-matching suffix puts the typed
  // pattern's lookbehinds on code points too (REV-W2 F2), which is a
  // difference of Java's own between patterns, not of a class.
  it('reads \\w, \\d, \\s, \\b and scripts as the server reads the typed pattern', () => {
    const S = `(?:(?!)${String.fromCodePoint(0x10ffff)})?`;
    const typed = cases
      .filter(({ p, opts }) => !Object.keys(opts).length && !/\(\?[a-z]*i/.test(p))
      .map(({ p, opts }) => ({ p, opts, java: p + S, source: translatePattern(p).source }));
    expect(typed.length).toBeGreaterThan(100);
    expect(differences(typed)).toEqual([]);
  }, 120_000);

  // Every script the server's Java knows is read, by its name, and finds the
  // characters Java's \p{IsX} finds: one character of each script against
  // every script.
  it("reads every script the server's Java knows as Java reads it", () => {
    const rows = execFileSync('java', [TOOL, 'scripts'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((line) => line.split('\t'));
    expect(rows.length).toBeGreaterThan(150);
    const samples = rows.map(([, cp]) => String.fromCodePoint(parseInt(cp, 16)));
    const lines = [];
    const browser = [];
    for (const [name] of rows) {
      const t = translatePattern(`^\\p{Is${name}}$`);
      expect([name, t.error]).toEqual([name, null]);
      expect(t.server.toUpperCase()).toContain(`SC=${name}}`);
      const re = new RegExp(t.source, 'u');
      for (const s of samples) {
        lines.push(`${hex(`^\\p{Is${name}}$`)}\t${hex(s)}`);
        browser.push(re.test(s) ? '1' : '0');
      }
    }
    const out = java(lines);
    const differ = out.flatMap((a, k) => (a === browser[k] ? [] : [lines[k]]));
    expect(differ).toEqual([]);
  }, 120_000);
});
