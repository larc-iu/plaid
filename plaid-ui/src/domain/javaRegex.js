// A pattern the person typed, read the way the server reads it, and written
// out twice: once for the server's query (a Java regex) and once for this
// browser (a JS RegExp with the `u` flag). Search finds documents with the
// first and Bulk Edit and the vocabulary's Replace plan their rows with the
// second, so the two must match exactly the same values. Handing the typed
// pattern to both engines did not: `\p{L}` found every word on the server and
// nothing in the browser, and `\b`, `\s`, `.`, `$` and `(?i)` each differ
// between the two dialects.
//
// So nothing is left to either engine's dialect. The pattern is parsed as Java
// syntax, the way the server compiles it (with UNICODE_CHARACTER_CLASS, ruled
// 2026-10-02: Plaid's users write Lezgi, Hijazi, Saraiki), and every construct
// whose meaning differs is written out in a form both engines read the same
// way:
//   \w                                   Java's Unicode word character: an
//                                        alphabetic character, a mark, a
//                                        decimal digit, a connector or a joiner
//                                        (U+200C, U+200D)
//   \d                                   a decimal digit in any script, \p{Nd}
//   \s                                   Unicode white space (U+00A0 too)
//   \h \v and the negations              Java's explicit classes
//   \b                                   lookarounds over that \w
//   \p{IsArabic}, \p{sc=Arabic}          the script, written \p{sc=Arabic}
//   .                                    a class without Java's line ends
//   $ \Z                                 a lookahead for one final line end
//   (?i) and the "any case" match        each letter becomes the class of
//                                        letters Unicode's simple case folding
//                                        makes equal (javaCaseFolds.js, from
//                                        tools/caseFolds.mjs: ı and İ stay
//                                        apart from i), so neither engine
//                                        folds case itself and the server gets
//                                        no flag
// What is left out (nested classes, `&&`, possessive and atomic groups, `\G`,
// `\B` (Java and JS also try it between the two halves of an emoji, Python
// does not), blocks (\p{InCyrillic}), POSIX and Java properties, flags other
// than i, u, U and s, back references that may not have matched) is refused
// with a message rather than read two ways. plaid-agent's core/java_regex.py is
// the same translator, kept in step by plaid-agent/tests/test_java_regex.py,
// and both are checked against Java itself (plaid-ui/tools/JavaRegex.java
// oracle) in javaRegex.test.js.
//
// One reading differs from the server's on purpose: Java's case-insensitive
// flag folds İ and ı with i, and the translators keep them apart (Unicode's
// simple case folding, ruled 2026-10-02). The translators send no flag, so the
// server never folds case for them.
//
// Unicode categories, scripts and Alphabetic are read by each engine's own
// tables, which can differ for characters added to Unicode after the server's
// Java release.

import FOLDS from './javaCaseFolds.js';

/** The server refuses a longer pattern (plaid.query.clauses/regex-max-len). */
export const SERVER_PATTERN_MAX = 4096;

export class PatternError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PatternError';
  }
}

const fail = (message) => {
  throw new PatternError(message);
};

const MAX_CP = 0x10ffff;
// Java's Unicode word character (UNICODE_CHARACTER_CLASS): Alphabetic, a mark,
// a decimal digit, a connector such as _, or a joiner. Written as properties
// every engine reads, and the two joiners as themselves.
const WORD_PROPS = ['Alphabetic', 'M', 'Nd', 'Pc'];
const JOINERS = [[0x200c, 0x200d]];
const prop = (name, negated = false) => ({ name, negated });
// Unicode's White_Space, which is Java's Unicode \s.
const SPACE = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0x85, 0x85],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
];
const HSPACE = [
  [0x09, 0x09],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x180e, 0x180e],
  [0x2000, 0x200a],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
];
const VSPACE = [
  [0x0a, 0x0d],
  [0x85, 0x85],
  [0x2028, 0x2029],
];
// Java's line terminators, which `.` does not match and `$` may stand before.
const LINE_END = [
  [0x0a, 0x0a],
  [0x0d, 0x0d],
  [0x85, 0x85],
  [0x2028, 0x2029],
];
const ESCAPE_SETS = { s: SPACE, h: HSPACE, v: VSPACE };

// General categories every engine reads by the same name. Cs and Cn are left
// out: they depend most on the Unicode version.
const CATEGORIES = new Set(
  'L Lu Ll Lt Lm Lo M Mn Mc Me N Nd Nl No P Pc Pd Ps Pe Pi Pf Po S Sm Sc Sk So Z Zs Zl Zp C Cc Cf Co'.split(
    ' ',
  ),
);
const CASED = new Set(['Lu', 'Ll', 'Lt']);

// The Unicode scripts the server's Java knows (Unicode 15.0), by the name JS
// reads and Java's four-letter alias. Java finds a script by either, in any
// case. plaid-ui/tools/JavaRegex.java scripts lists them, and javaRegex.test.js
// holds this table to it.
const SCRIPTS = new Map();
for (const entry of (
  'Common:Zyyy Latin:Latn Greek:Grek Cyrillic:Cyrl Armenian:Armn Hebrew:Hebr Arabic:Arab ' +
  'Syriac:Syrc Thaana:Thaa Devanagari:Deva Bengali:Beng Gurmukhi:Guru Gujarati:Gujr ' +
  'Oriya:Orya Tamil:Taml Telugu:Telu Kannada:Knda Malayalam:Mlym Sinhala:Sinh Thai ' +
  'Lao:Laoo Tibetan:Tibt Myanmar:Mymr Georgian:Geor Hangul:Hang Ethiopic:Ethi ' +
  'Cherokee:Cher Canadian_Aboriginal:Cans Ogham:Ogam Runic:Runr Khmer:Khmr Mongolian:Mong ' +
  'Hiragana:Hira Katakana:Kana Bopomofo:Bopo Han:Hani Yi:Yiii Old_Italic:Ital Gothic:Goth ' +
  'Deseret:Dsrt Inherited:Zinh Tagalog:Tglg Hanunoo:Hano Buhid:Buhd Tagbanwa:Tagb ' +
  'Limbu:Limb Tai_Le:Tale Linear_B:Linb Ugaritic:Ugar Shavian:Shaw Osmanya:Osma ' +
  'Cypriot:Cprt Braille:Brai Buginese:Bugi Coptic:Copt New_Tai_Lue:Talu Glagolitic:Glag ' +
  'Tifinagh:Tfng Syloti_Nagri:Sylo Old_Persian:Xpeo Kharoshthi:Khar Balinese:Bali ' +
  'Cuneiform:Xsux Phoenician:Phnx Phags_Pa:Phag Nko:Nkoo Sundanese:Sund Batak:Batk ' +
  'Lepcha:Lepc Ol_Chiki:Olck Vai:Vaii Saurashtra:Saur Kayah_Li:Kali Rejang:Rjng ' +
  'Lycian:Lyci Carian:Cari Lydian:Lydi Cham Tai_Tham:Lana Tai_Viet:Tavt Avestan:Avst ' +
  'Egyptian_Hieroglyphs:Egyp Samaritan:Samr Mandaic:Mand Lisu Bamum:Bamu Javanese:Java ' +
  'Meetei_Mayek:Mtei Imperial_Aramaic:Armi Old_South_Arabian:Sarb ' +
  'Inscriptional_Parthian:Prti Inscriptional_Pahlavi:Phli Old_Turkic:Orkh Brahmi:Brah ' +
  'Kaithi:Kthi Meroitic_Hieroglyphs:Mero Meroitic_Cursive:Merc Sora_Sompeng:Sora ' +
  'Chakma:Cakm Sharada:Shrd Takri:Takr Miao:Plrd Caucasian_Albanian:Aghb Bassa_Vah:Bass ' +
  'Duployan:Dupl Elbasan:Elba Grantha:Gran Pahawh_Hmong:Hmng Khojki:Khoj Linear_A:Lina ' +
  'Mahajani:Mahj Manichaean:Mani Mende_Kikakui:Mend Modi Mro:Mroo Old_North_Arabian:Narb ' +
  'Nabataean:Nbat Palmyrene:Palm Pau_Cin_Hau:Pauc Old_Permic:Perm Psalter_Pahlavi:Phlp ' +
  'Siddham:Sidd Khudawadi:Sind Tirhuta:Tirh Warang_Citi:Wara Ahom ' +
  'Anatolian_Hieroglyphs:Hluw Hatran:Hatr Multani:Mult Old_Hungarian:Hung ' +
  'SignWriting:Sgnw Adlam:Adlm Bhaiksuki:Bhks Marchen:Marc Newa Osage:Osge Tangut:Tang ' +
  'Masaram_Gondi:Gonm Nushu:Nshu Soyombo:Soyo Zanabazar_Square:Zanb Hanifi_Rohingya:Rohg ' +
  'Old_Sogdian:Sogo Sogdian:Sogd Dogra:Dogr Gunjala_Gondi:Gong Makasar:Maka ' +
  'Medefaidrin:Medf Elymaic:Elym Nandinagari:Nand Nyiakeng_Puachue_Hmong:Hmnp Wancho:Wcho ' +
  'Yezidi:Yezi Chorasmian:Chrs Dives_Akuru:Diak Khitan_Small_Script:Kits Vithkuqi:Vith ' +
  'Old_Uyghur:Ougr Cypro_Minoan:Cpmn Tangsa:Tnsa Toto Kawi Nag_Mundari:Nagm'
).split(' ')) {
  const [name, alias] = entry.split(':');
  SCRIPTS.set(name.toUpperCase(), name);
  if (alias) SCRIPTS.set(alias.toUpperCase(), name);
}
// How Java spells a property this module writes, where it differs.
const JAVA_PROPS = { Alphabetic: 'IsAlphabetic' };
const MAX_COUNT = 1000;

// ---- ranges ------------------------------------------------------------------

const normalize = (ranges) => {
  const sorted = ranges.map((r) => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
};

const complement = (ranges) => {
  const out = [];
  let next = 0;
  for (const [lo, hi] of normalize(ranges)) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX_CP) out.push([next, MAX_CP]);
  return out;
};

const inRanges = (ranges, cp) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

let foldClasses = null;
let foldOf = null;
const loadFolds = () => {
  if (foldClasses) return;
  foldClasses = FOLDS.map((s) => Array.from(s, (c) => c.codePointAt(0)));
  foldOf = new Map();
  for (const cls of foldClasses) for (const cp of cls) foldOf.set(cp, cls);
};

// The ranges plus every letter that folds together with one inside them.
const folded = (ranges) => {
  loadFolds();
  const extra = [];
  for (const cls of foldClasses) {
    if (cls.some((cp) => inRanges(ranges, cp))) for (const cp of cls) extra.push([cp, cp]);
  }
  return normalize([...ranges, ...extra]);
};

// ---- parsing (Java syntax) ---------------------------------------------------

const isDigit = (c) => c >= 0x30 && c <= 0x39;
const isHex = (c) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const isAsciiLetter = (c) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const ch = (c) => String.fromCodePoint(c);

// A set node: `lits` are typed characters and ranges (folded under (?i)),
// `fixed` come from escapes like \w (never folded), `props` are \p{..}.
const setNode = ({ negated = false, lits = [], fixed = [], props = [], ci = false }) => ({
  t: 'set',
  negated,
  ranges: normalize([...(ci ? folded(lits) : lits), ...fixed]),
  props,
});

function parse(pattern, caseInsensitive) {
  const cps = Array.from(pattern, (c) => c.codePointAt(0));
  let i = 0;
  let flags = { ci: caseInsensitive, dotall: false };
  let groupCount = 0;
  const groupNames = new Map();
  const peek = (k = 0) => cps[i + k];
  const atEnd = () => i >= cps.length;

  const charNode = (cp) => (flags.ci ? setNode({ lits: [[cp, cp]], ci: true }) : { t: 'char', cp });

  const readHex = (n) => {
    let v = 0;
    for (let k = 0; k < n; k++) {
      const c = cps[i];
      if (c === undefined || !isHex(c)) fail('\\x and \\u take hex digits.');
      v = v * 16 + parseInt(ch(c), 16);
      i++;
    }
    return v;
  };

  const property = (negated) => {
    let name;
    if (peek() === 0x7b) {
      const close = cps.indexOf(0x7d, i);
      if (close < 0) fail('Unclosed \\p{.');
      name = cps
        .slice(i + 1, close)
        .map(ch)
        .join('');
      i = close + 1;
    } else {
      if (atEnd()) fail('\\p needs a category, such as \\p{L}.');
      name = ch(cps[i++]);
    }
    const shown = `\\${negated ? 'P' : 'p'}{${name}}`;
    // Java's reading: `key=value` with the key in any case, `In` a block, `Is`
    // a category or a script, and a bare name a category.
    const eq = name.indexOf('=');
    const key = eq < 0 ? null : name.slice(0, eq).toLowerCase();
    const value = eq < 0 ? null : name.slice(eq + 1);
    const script = (s) => SCRIPTS.get(s.toUpperCase());
    let found = null;
    if (key === 'gc' || key === 'general_category') {
      if (CATEGORIES.has(value)) found = value;
    } else if (key === 'sc' || key === 'script') {
      if (script(value)) found = `sc=${script(value)}`;
    } else if (key === 'blk' || key === 'block' || (key === null && name.startsWith('In'))) {
      fail(`${shown} is a block, which is not supported. Use a script such as \\p{IsCyrillic}.`);
    } else if (key === null && name.startsWith('Is')) {
      const rest = name.slice(2);
      if (CATEGORIES.has(rest)) found = rest;
      else if (script(rest)) found = `sc=${script(rest)}`;
    } else if (key === null && CATEGORIES.has(name)) found = name;
    if (!found)
      fail(
        `${shown} is not supported. Use a category such as \\p{L} or a script such as \\p{IsArabic}.`,
      );
    if (flags.ci && CASED.has(found)) fail(`${shown} cannot be used with (?i).`);
    return { name: found, negated };
  };

  // One escape after the backslash. In a class it gives a character
  // ({cp}) or a set ({fixed, props}). Outside, any node.
  const escape = (inClass) => {
    if (atEnd()) fail('The pattern ends with a backslash.');
    const c = cps[i++];
    const name = ch(c);
    switch (name) {
      case 't':
        return { cp: 0x09 };
      case 'n':
        return { cp: 0x0a };
      case 'r':
        return { cp: 0x0d };
      case 'f':
        return { cp: 0x0c };
      case 'a':
        return { cp: 0x07 };
      case 'e':
        return { cp: 0x1b };
      case '0': {
        // Java's octal: \0n, \0nn, \0mnn with m at most 3.
        const oct = (k) => cps[i + k] >= 0x30 && cps[i + k] <= 0x37;
        if (!oct(0)) fail('\\0 takes octal digits.');
        let v = cps[i++] - 0x30;
        if (oct(0)) {
          v = v * 8 + (cps[i++] - 0x30);
          if (oct(0) && v <= 0o37) v = v * 8 + (cps[i++] - 0x30);
        }
        return { cp: v };
      }
      case 'x': {
        if (peek() === 0x7b) {
          i++;
          let v = 0;
          let n = 0;
          while (!atEnd() && isHex(peek())) {
            v = v * 16 + parseInt(ch(cps[i++]), 16);
            n++;
            if (v > MAX_CP) fail('\\x{..} is past the last code point.');
          }
          if (!n || peek() !== 0x7d) fail('\\x{..} takes hex digits.');
          i++;
          return { cp: v };
        }
        return { cp: readHex(2) };
      }
      case 'u': {
        const v = readHex(4);
        if (v >= 0xd800 && v <= 0xdbff && peek() === 0x5c && peek(1) === 0x75) {
          i += 2;
          const lo = readHex(4);
          if (lo < 0xdc00 || lo > 0xdfff) fail('A lone surrogate is not supported.');
          return { cp: 0x10000 + ((v - 0xd800) << 10) + (lo - 0xdc00) };
        }
        if (v >= 0xd800 && v <= 0xdfff) fail('A lone surrogate is not supported.');
        return { cp: v };
      }
      case 'c': {
        if (atEnd()) fail('\\c needs a character.');
        return { cp: cps[i++] ^ 64 };
      }
      case 'd':
        return { fixed: [], props: [prop('Nd')] };
      case 'D':
        return { fixed: [], props: [prop('Nd', true)] };
      case 'w':
        return { fixed: JOINERS, props: WORD_PROPS.map((n) => prop(n)) };
      case 'W':
        // Not a word character in any of its parts: a class of its own.
        if (inClass) fail('\\W is not supported in [...]. Use [^\\w...] instead.');
        return { negatedSet: true, fixed: JOINERS, props: WORD_PROPS.map((n) => prop(n)) };
      case 's':
      case 'h':
      case 'v':
        return { fixed: ESCAPE_SETS[name], props: [] };
      case 'S':
      case 'H':
      case 'V':
        return { fixed: complement(ESCAPE_SETS[name.toLowerCase()]), props: [] };
      case 'p':
      case 'P':
        return { fixed: [], props: [property(name === 'P')] };
      default:
        break;
    }
    if (isDigit(c) || isAsciiLetter(c)) {
      if (inClass) fail(`\\${name} is not supported in [...].`);
      return escapeOutside(c);
    }
    return { cp: c };
  };

  const escapeOutside = (c) => {
    const name = ch(c);
    if (name === 'b') return { node: { t: 'wordb' } };
    if (name === 'A') return { node: { t: 'start' } };
    if (name === 'z') return { node: { t: 'end' } };
    if (name === 'Z') return { node: { t: 'dollar' } };
    if (name === 'Q') {
      const nodes = [];
      while (!atEnd() && !(peek() === 0x5c && peek(1) === 0x45)) nodes.push(charNode(cps[i++]));
      if (!atEnd()) i += 2;
      return { nodes };
    }
    if (name === 'k') {
      if (peek() !== 0x3c) fail('\\k needs a group name, as in \\k<name>.');
      const close = cps.indexOf(0x3e, i);
      if (close < 0) fail('Unclosed \\k<.');
      const gname = cps
        .slice(i + 1, close)
        .map(ch)
        .join('');
      i = close + 1;
      if (!groupNames.has(gname)) fail(`No group named ${gname}.`);
      return { node: backref(groupNames.get(gname)) };
    }
    if (c >= 0x31 && c <= 0x39) {
      // Java: \1 to \9 always, a longer number only while that many groups
      // exist at this point.
      let n = c - 0x30;
      while (!atEnd() && isDigit(peek())) {
        const next = n * 10 + (peek() - 0x30);
        if (next > groupCount) break;
        n = next;
        i++;
      }
      if (n > groupCount) fail(`\\${n} refers to a group that does not exist.`);
      return { node: backref(n) };
    }
    return fail(`\\${name} is not supported.`);
  };

  const backref = (n) => {
    if (flags.ci) fail('A back reference cannot be used with (?i).');
    return { t: 'backref', n };
  };

  const parseClass = () => {
    let negated = false;
    if (peek() === 0x5e) {
      negated = true;
      i++;
    }
    if (peek() === 0x5d) fail('Write \\] for a ] inside [...].');
    const lits = [];
    const fixed = [];
    const props = [];
    const single = () => {
      const c = cps[i];
      if (c === 0x5b) fail('Nested [...] is not supported. Write \\[ for a [.');
      if (c === 0x26 && peek(1) === 0x26) fail('&& in [...] is not supported.');
      i++;
      if (c === 0x5c) return escape(true);
      return { cp: c };
    };
    for (;;) {
      if (atEnd()) fail('Unclosed [.');
      if (peek() === 0x5d) {
        i++;
        break;
      }
      const item = single();
      const rangeNext = peek() === 0x2d && peek(1) !== undefined && peek(1) !== 0x5d;
      if (item.cp === undefined) {
        if (rangeNext) fail('A range cannot start or end at a class like \\w.');
        fixed.push(...item.fixed);
        props.push(...item.props);
        continue;
      }
      if (!rangeNext) {
        lits.push([item.cp, item.cp]);
        continue;
      }
      i++;
      if (atEnd()) fail('Unclosed [.');
      const hi = single();
      if (hi.cp === undefined) fail('A range cannot start or end at a class like \\w.');
      if (hi.cp < item.cp) fail(`${ch(item.cp)}-${ch(hi.cp)} is not a range.`);
      lits.push([item.cp, hi.cp]);
    }
    return setNode({ negated, lits, fixed, props, ci: flags.ci });
  };

  const parseFlags = () => {
    // After "(?": letters, maybe "-" and more letters, then ")" or ":".
    const next = { ...flags };
    let on = true;
    let letters = 0;
    for (;;) {
      if (atEnd()) fail('Unclosed group.');
      const c = ch(cps[i]);
      if (c === ')' || c === ':') {
        if (!letters) fail('(? must be followed by a flag or a group kind.');
        break;
      }
      i++;
      letters += 1;
      if (c === '-') {
        on = false;
        continue;
      }
      if (c === 'i') next.ci = on;
      else if (c === 's') next.dotall = on;
      else if (c === 'u') continue;
      // The server compiles every pattern with UNICODE_CHARACTER_CLASS.
      else if (c === 'U' && on) continue;
      else fail(`(?${on ? '' : '-'}${c}) is not supported.`);
    }
    return next;
  };

  const parseGroup = () => {
    // At "(", already consumed.
    const saved = flags;
    let node;
    if (peek() === 0x3f) {
      i++;
      const c = peek();
      const c1 = peek(1);
      if (c === 0x3a) {
        i++;
        node = { t: 'group', kind: 'nc' };
      } else if (c === 0x3d || c === 0x21) {
        i++;
        node = { t: 'group', kind: c === 0x3d ? 'la' : 'nla' };
      } else if (c === 0x3c && (c1 === 0x3d || c1 === 0x21)) {
        i += 2;
        node = { t: 'group', kind: c1 === 0x3d ? 'lb' : 'nlb' };
      } else if (c === 0x3c) {
        i++;
        const close = cps.indexOf(0x3e, i);
        const name = close < 0 ? '' : cps.slice(i, close).map(ch).join('');
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) fail('A group name is letters and digits.');
        if (groupNames.has(name)) fail(`Two groups are named ${name}.`);
        i = close + 1;
        groupCount += 1;
        groupNames.set(name, groupCount);
        node = { t: 'group', kind: 'cap', n: groupCount, name };
      } else if (c === 0x3e) {
        fail('(?>...) is not supported.');
      } else {
        const next = parseFlags();
        if (peek() === 0x29) {
          // (?i) alone: on until the end of the enclosing group.
          i++;
          flags = next;
          return null;
        }
        i++;
        flags = next;
        node = { t: 'group', kind: 'nc' };
      }
    } else {
      groupCount += 1;
      node = { t: 'group', kind: 'cap', n: groupCount };
    }
    node.body = parseAlt();
    if (peek() !== 0x29) fail('Unclosed group.');
    i++;
    flags = saved;
    return node;
  };

  const ASSERTIONS = new Set(['start', 'end', 'dollar', 'wordb']);
  const isAssertion = (n) =>
    ASSERTIONS.has(n.t) || (n.t === 'group' && ['la', 'nla', 'lb', 'nlb'].includes(n.kind));

  const quantifier = () => {
    const c = peek();
    let min;
    let max;
    if (c === 0x2a) [min, max] = [0, Infinity];
    else if (c === 0x2b) [min, max] = [1, Infinity];
    else if (c === 0x3f) [min, max] = [0, 1];
    else if (c === 0x7b) {
      let j = i + 1;
      const num = () => {
        let s = '';
        while (cps[j] !== undefined && isDigit(cps[j])) s += ch(cps[j++]);
        return s;
      };
      const a = num();
      let b = a;
      if (cps[j] === 0x2c) {
        j++;
        b = num();
        if (b === '') b = null;
      }
      if (a === '' || cps[j] !== 0x7d) fail('Write \\{ for a {.');
      min = Number(a);
      max = b === null ? Infinity : Number(b);
      if (min > MAX_COUNT || (max !== Infinity && max > MAX_COUNT))
        fail(`A count above ${MAX_COUNT} is not supported.`);
      if (max < min) fail(`In {${a},${b}} the first number is larger.`);
      i = j + 1;
    } else return null;
    if (c !== 0x7b) i++;
    let lazy = false;
    if (peek() === 0x3f) {
      lazy = true;
      i++;
    } else if (peek() === 0x2b) fail('Possessive quantifiers (*+, ++, ?+) are not supported.');
    return { min, max, lazy };
  };

  const isQuantChar = (c) => c === 0x2a || c === 0x2b || c === 0x3f || c === 0x7b;

  const parseSeq = () => {
    const items = [];
    for (;;) {
      if (atEnd()) break;
      const c = peek();
      if (c === 0x7c || c === 0x29) break;
      i++;
      let nodes;
      if (c === 0x28) {
        const g = parseGroup();
        nodes = g ? [g] : [];
      } else if (c === 0x5b) nodes = [parseClass()];
      else if (c === 0x2e)
        nodes = [
          flags.dotall
            ? setNode({ fixed: [[0, MAX_CP]] })
            : setNode({ negated: true, fixed: LINE_END }),
        ];
      else if (c === 0x5e) nodes = [{ t: 'start' }];
      else if (c === 0x24) nodes = [{ t: 'dollar' }];
      else if (c === 0x5c) {
        const e = escape(false);
        if (e.cp !== undefined) nodes = [charNode(e.cp)];
        else if (e.node) nodes = [e.node];
        else if (e.nodes) nodes = e.nodes;
        else nodes = [setNode({ negated: !!e.negatedSet, fixed: e.fixed, props: e.props })];
      } else if (isQuantChar(c)) {
        fail(`Nothing to repeat before ${ch(c)}. Write \\${ch(c)} for the character.`);
      } else nodes = [charNode(c)];
      items.push(...nodes);
      if (!atEnd() && isQuantChar(peek())) {
        const last = nodes[nodes.length - 1];
        if (!last || isAssertion(last))
          fail(`Nothing to repeat before ${ch(peek())}. Write \\${ch(peek())} for the character.`);
        const q = quantifier();
        if (q) {
          items[items.length - 1] = { t: 'rep', ...q, body: last };
          if (!atEnd() && isQuantChar(peek()))
            fail(
              `Nothing to repeat before ${ch(peek())}. Write \\${ch(peek())} for the character.`,
            );
        }
      }
    }
    return items.length === 1 ? items[0] : { t: 'seq', items };
  };

  const parseAlt = () => {
    const branches = [parseSeq()];
    while (peek() === 0x7c) {
      i++;
      branches.push(parseSeq());
    }
    return branches.length === 1 ? branches[0] : { t: 'alt', branches };
  };

  const ast = parseAlt();
  if (!atEnd()) fail('Unmatched ).');
  check(ast);
  return ast;
}

// A back reference must name a group that has certainly matched by then:
// Java fails on a group that did not take part, JS matches it as empty.
// A lookbehind needs a bounded length (Java's rule).
function check(ast) {
  const groups = new Map(); // n -> { closed, conditional }
  const walk = (node, conditional, inBehind) => {
    switch (node.t) {
      case 'seq':
        node.items.forEach((n) => walk(n, conditional, inBehind));
        break;
      case 'alt':
        node.branches.forEach((n) => walk(n, true, inBehind));
        break;
      case 'rep':
        walk(node.body, conditional || node.min === 0, inBehind);
        break;
      case 'group': {
        const look = node.kind !== 'cap' && node.kind !== 'nc';
        const behind = node.kind === 'lb' || node.kind === 'nlb';
        if (behind && maxLength(node.body) === Infinity)
          fail('A lookbehind must have a bounded length.');
        if (node.kind === 'cap') groups.set(node.n, { closed: false, conditional });
        walk(node.body, conditional || look, inBehind || behind);
        if (node.kind === 'cap') groups.get(node.n).closed = true;
        break;
      }
      case 'backref': {
        const g = groups.get(node.n);
        if (inBehind) fail('A back reference inside a lookbehind is not supported.');
        if (!g || !g.closed || g.conditional)
          fail(`\\${node.n} must refer to a group that always matches before it.`);
        break;
      }
      default:
        break;
    }
  };
  walk(ast, false, false);
}

function maxLength(node) {
  switch (node.t) {
    case 'char':
    case 'set':
      return 1;
    case 'seq':
      return node.items.reduce((a, n) => a + maxLength(n), 0);
    case 'alt':
      return Math.max(...node.branches.map(maxLength));
    case 'rep':
      return node.max === 0 ? 0 : node.max * maxLength(node.body);
    case 'group':
      return node.kind === 'cap' || node.kind === 'nc' ? maxLength(node.body) : 0;
    case 'backref':
      return Infinity;
    default:
      return 0;
  }
}

// ---- writing it out ----------------------------------------------------------

// Characters written as an escape rather than as themselves: controls,
// spaces, format and invisible characters, surrogates and private use. A
// fixed list, so the two clients write the same pattern whatever Unicode
// version each one's tables know.
const HIDDEN = [
  [0x80, 0x9f],
  [0xad, 0xad],
  [0x34f, 0x34f],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x2000, 0x200f],
  [0x2028, 0x202f],
  [0x205f, 0x206f],
  [0x3000, 0x3000],
  [0x3164, 0x3164],
  [0xd800, 0xf8ff],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xffff],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
  [0xf0000, 0x10ffff],
];
const hex2 = (c) => c.toString(16).padStart(2, '0');

const encodeChar = (cp, engine) => {
  if ((cp >= 0x30 && cp <= 0x39) || isAsciiLetter(cp) || cp === 0x5f) return ch(cp);
  if (cp < 0x80) return `\\x${hex2(cp)}`;
  if (!inRanges(HIDDEN, cp)) return ch(cp);
  return engine === 'java' ? `\\x{${cp.toString(16)}}` : `\\u{${cp.toString(16)}}`;
};

const encodeProp = (p, engine) =>
  `\\${p.negated ? 'P' : 'p'}{${(engine === 'java' && JAVA_PROPS[p.name]) || p.name}}`;

const encodeSet = (node, engine) => {
  const { ranges, props, negated } = node;
  if (!ranges.length && props.length === 1 && !negated) return encodeProp(props[0], engine);
  if (!ranges.length && !props.length)
    return negated ? encodeSet({ ranges: [[0, MAX_CP]], props: [] }, engine) : '(?!)';
  if (!negated && !props.length && ranges.length === 1 && ranges[0][0] === ranges[0][1])
    return encodeChar(ranges[0][0], engine);
  let out = negated ? '[^' : '[';
  for (const [lo, hi] of ranges) {
    out += encodeChar(lo, engine);
    if (hi > lo) out += (hi > lo + 1 ? '-' : '') + encodeChar(hi, engine);
  }
  for (const p of props) out += encodeProp(p, engine);
  return `${out}]`;
};

const END = { java: '\\z', js: '$' };

// Java reads a pattern by UTF-16 units unless the pattern itself holds a
// character outside the BMP: then its lookbehinds and \b step back a whole
// code point, as JS and Python do. A branch that never matches, holding one
// such character written as itself (an escape does not count), switches the
// server's pattern to that reading, so Adlam, Osage or CJK Extension B letters
// stay letters on both sides of a lookbehind (REV-W2 F2).
const SUPPLEMENTARY = `(?:(?!)${String.fromCodePoint(0x10ffff)})?`;
const WORD_SET = { ranges: JOINERS, props: WORD_PROPS.map((n) => prop(n)) };

const emit = (node, engine) => {
  switch (node.t) {
    case 'char':
      return encodeChar(node.cp, engine);
    case 'set':
      return encodeSet(node, engine);
    case 'start':
      return '^';
    case 'end':
      return END[engine];
    case 'dollar':
      return `(?=(?:\\x0d\\x0a|${encodeSet({ ranges: LINE_END, props: [] }, engine)})?${END[engine]})`;
    case 'wordb': {
      const w = encodeSet(WORD_SET, engine);
      return `(?:(?<=${w})(?!${w})|(?<!${w})(?=${w}))`;
    }
    case 'backref':
      return `(?:\\${node.n})`;
    case 'seq':
      return node.items.map((n) => emit(n, engine)).join('');
    case 'alt':
      return node.branches.map((n) => emit(n, engine)).join('|');
    case 'group': {
      const body = emit(node.body, engine);
      if (node.kind === 'cap') {
        return node.name ? `(?<${node.name}>${body})` : `(${body})`;
      }
      const open = { nc: '(?:', la: '(?=', nla: '(?!', lb: '(?<=', nlb: '(?<!' }[node.kind];
      return `${open}${body})`;
    }
    case 'rep': {
      let body = emit(node.body, engine);
      const atom =
        node.body.t === 'group' ||
        node.body.t === 'backref' ||
        node.body.t === 'set' ||
        (node.body.t === 'char' && [...body].length === 1) ||
        /^\\x[0-9a-f]{2}$|^\\[xu]\{[0-9a-f]+\}$/.test(body);
      if (!atom) body = `(?:${body})`;
      let q;
      if (node.min === 0 && node.max === Infinity) q = '*';
      else if (node.min === 1 && node.max === Infinity) q = '+';
      else if (node.min === 0 && node.max === 1) q = '?';
      else if (node.max === Infinity) q = `{${node.min},}`;
      else if (node.max === node.min) q = `{${node.min}}`;
      else q = `{${node.min},${node.max}}`;
      return body + q + (node.lazy ? '?' : '');
    }
    default:
      throw new Error(`unknown node ${node.t}`);
  }
};

/**
 * Read `pattern` as the server would and write it out for each engine.
 *
 * Options: `literal` (the text itself, not a pattern), `caseInsensitive` (the
 * "any case" match, the same as a leading (?i)), `whole` (the whole value).
 * Returns { server, source, error }: `server` is the pattern to send in a
 * query's `{regex}` (with no flags), `source` the same pattern for
 * `new RegExp(source, 'gu')`, with the same groups. A pattern that is not
 * supported, or too long for the server, gives `error` and nulls.
 */
export function translatePattern(
  pattern,
  { literal = false, caseInsensitive = false, whole = false } = {},
) {
  try {
    let ast;
    if (literal) {
      const items = Array.from(pattern, (c) => {
        const cp = c.codePointAt(0);
        return caseInsensitive ? setNode({ lits: [[cp, cp]], ci: true }) : { t: 'char', cp };
      });
      ast = items.length === 1 ? items[0] : { t: 'seq', items };
    } else {
      ast = parse(pattern, caseInsensitive);
    }
    const wrap = (engine) => {
      const body = emit(ast, engine);
      return whole ? `^(?:${body})${END[engine]}` : body;
    };
    const server = wrap('java') + SUPPLEMENTARY;
    if (server.length > SERVER_PATTERN_MAX) fail('The pattern is too long.');
    return { server, source: wrap('js'), error: null };
  } catch (err) {
    if (err instanceof PatternError) return { server: null, source: null, error: err.message };
    throw err;
  }
}
