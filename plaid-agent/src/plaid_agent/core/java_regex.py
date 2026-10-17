"""A pattern read the way the server reads it, written out for the server and
for this process.

The server matches a query's ``{"regex": ...}`` with Java's
``java.util.regex``, compiled with ``UNICODE_CHARACTER_CLASS``, and a replace
rewrites the values it found here, in Python. The two dialects disagree:
``[[:alpha:]]`` is a POSIX class in one and a nested set in the other,
``\\p{L}``, ``\\p{IsArabic}`` and ``\\h`` exist only in Java, ``\\w`` and
``\\s`` take other characters in each, and ``$`` and ``.`` know other line
ends. So a replace that handed the same text to both found one set of values
and rewrote another.

This is the same translator as the browser's ``javaRegex.js`` in plaid-ui,
which every app's regex box goes through, kept in step by
``tests/test_java_regex.py``: the pattern is parsed as Java syntax, and every
construct whose meaning differs is written out in a form both engines read
the same way. ``\\w`` is Java's Unicode word character (Alphabetic, a mark, a
decimal digit, a connector or a joiner), ``\\d`` a decimal digit in any
script, ``\\s`` Unicode white space, ``\\h \\v`` Java's explicit classes,
``\\b`` lookarounds over that ``\\w``, a script typed ``\\p{IsArabic}`` or
``\\p{sc=Arabic}`` as ``\\p{sc=Arabic}``, ``.`` and ``$`` Java's line ends, and
each letter of a case-insensitive pattern the class of letters Unicode's simple
case folding makes equal (ı and İ stay apart from i, where Java's own flag
would fold them, ruled 2026-10-02), so neither engine folds case itself and the
server gets no flag. What it cannot write out the same way (a block such as
``\\p{InCyrillic}``, a POSIX class, a nested set) is refused with a message.
The local side uses the ``regex`` package, which reads ``\\p{..}`` and
lookbehinds of any length.
"""

import functools
import unicodedata
from typing import Callable, List, NamedTuple, Optional

import regex

from .java_case_folds import FOLDS

#: The server refuses a longer pattern (plaid.query.clauses/regex-max-len).
SERVER_PATTERN_MAX = 4096


class PatternError(ValueError):
    """A pattern that cannot be read the server's way. The message says why."""


class Translated(NamedTuple):
    #: The pattern to send in a query's ``{"regex": ...}``, with no flags.
    server: str
    #: The same pattern for ``regex.compile``, with the same groups.
    local: str


MAX_CP = 0x10FFFF
#: Java's Unicode word character (UNICODE_CHARACTER_CLASS): Alphabetic, a mark,
#: a decimal digit, a connector such as _, or a joiner. Written as properties
#: every engine reads, and the two joiners as themselves.
WORD_PROPS = ['Alphabetic', 'M', 'Nd', 'Pc']
JOINERS = [(0x200C, 0x200D)]
#: Unicode's White_Space, which is Java's Unicode \s.
SPACE = [(0x09, 0x0D), (0x20, 0x20), (0x85, 0x85), (0xA0, 0xA0), (0x1680, 0x1680),
         (0x2000, 0x200A), (0x2028, 0x2029), (0x202F, 0x202F), (0x205F, 0x205F),
         (0x3000, 0x3000)]
HSPACE = [(0x09, 0x09), (0x20, 0x20), (0xA0, 0xA0), (0x1680, 0x1680), (0x180E, 0x180E),
          (0x2000, 0x200A), (0x202F, 0x202F), (0x205F, 0x205F), (0x3000, 0x3000)]
VSPACE = [(0x0A, 0x0D), (0x85, 0x85), (0x2028, 0x2029)]
LINE_END = [(0x0A, 0x0A), (0x0D, 0x0D), (0x85, 0x85), (0x2028, 0x2029)]
ESCAPE_SETS = {'s': SPACE, 'h': HSPACE, 'v': VSPACE}

CATEGORIES = set('L Lu Ll Lt Lm Lo M Mn Mc Me N Nd Nl No P Pc Pd Ps Pe Pi Pf Po '
                 'S Sm Sc Sk So Z Zs Zl Zp C Cc Cf Co'.split())
CASED = {'Lu', 'Ll', 'Lt'}

#: The Unicode scripts the server's Java knows (Unicode 15.0), by the name JS
#: reads and Java's four-letter alias. Java finds a script by either, in any
#: case. The same table as javaRegex.js.
SCRIPTS = {}
for _entry in (
    'Common:Zyyy Latin:Latn Greek:Grek Cyrillic:Cyrl Armenian:Armn Hebrew:Hebr '
    'Arabic:Arab Syriac:Syrc Thaana:Thaa Devanagari:Deva Bengali:Beng Gurmukhi:Guru '
    'Gujarati:Gujr Oriya:Orya Tamil:Taml Telugu:Telu Kannada:Knda Malayalam:Mlym '
    'Sinhala:Sinh Thai Lao:Laoo Tibetan:Tibt Myanmar:Mymr Georgian:Geor Hangul:Hang '
    'Ethiopic:Ethi Cherokee:Cher Canadian_Aboriginal:Cans Ogham:Ogam Runic:Runr '
    'Khmer:Khmr Mongolian:Mong Hiragana:Hira Katakana:Kana Bopomofo:Bopo Han:Hani Yi:Yiii '
    'Old_Italic:Ital Gothic:Goth Deseret:Dsrt Inherited:Zinh Tagalog:Tglg Hanunoo:Hano '
    'Buhid:Buhd Tagbanwa:Tagb Limbu:Limb Tai_Le:Tale Linear_B:Linb Ugaritic:Ugar '
    'Shavian:Shaw Osmanya:Osma Cypriot:Cprt Braille:Brai Buginese:Bugi Coptic:Copt '
    'New_Tai_Lue:Talu Glagolitic:Glag Tifinagh:Tfng Syloti_Nagri:Sylo Old_Persian:Xpeo '
    'Kharoshthi:Khar Balinese:Bali Cuneiform:Xsux Phoenician:Phnx Phags_Pa:Phag Nko:Nkoo '
    'Sundanese:Sund Batak:Batk Lepcha:Lepc Ol_Chiki:Olck Vai:Vaii Saurashtra:Saur '
    'Kayah_Li:Kali Rejang:Rjng Lycian:Lyci Carian:Cari Lydian:Lydi Cham Tai_Tham:Lana '
    'Tai_Viet:Tavt Avestan:Avst Egyptian_Hieroglyphs:Egyp Samaritan:Samr Mandaic:Mand '
    'Lisu Bamum:Bamu Javanese:Java Meetei_Mayek:Mtei Imperial_Aramaic:Armi '
    'Old_South_Arabian:Sarb Inscriptional_Parthian:Prti Inscriptional_Pahlavi:Phli '
    'Old_Turkic:Orkh Brahmi:Brah Kaithi:Kthi Meroitic_Hieroglyphs:Mero '
    'Meroitic_Cursive:Merc Sora_Sompeng:Sora Chakma:Cakm Sharada:Shrd Takri:Takr '
    'Miao:Plrd Caucasian_Albanian:Aghb Bassa_Vah:Bass Duployan:Dupl Elbasan:Elba '
    'Grantha:Gran Pahawh_Hmong:Hmng Khojki:Khoj Linear_A:Lina Mahajani:Mahj '
    'Manichaean:Mani Mende_Kikakui:Mend Modi Mro:Mroo Old_North_Arabian:Narb '
    'Nabataean:Nbat Palmyrene:Palm Pau_Cin_Hau:Pauc Old_Permic:Perm Psalter_Pahlavi:Phlp '
    'Siddham:Sidd Khudawadi:Sind Tirhuta:Tirh Warang_Citi:Wara Ahom '
    'Anatolian_Hieroglyphs:Hluw Hatran:Hatr Multani:Mult Old_Hungarian:Hung '
    'SignWriting:Sgnw Adlam:Adlm Bhaiksuki:Bhks Marchen:Marc Newa Osage:Osge Tangut:Tang '
    'Masaram_Gondi:Gonm Nushu:Nshu Soyombo:Soyo Zanabazar_Square:Zanb '
    'Hanifi_Rohingya:Rohg Old_Sogdian:Sogo Sogdian:Sogd Dogra:Dogr Gunjala_Gondi:Gong '
    'Makasar:Maka Medefaidrin:Medf Elymaic:Elym Nandinagari:Nand '
    'Nyiakeng_Puachue_Hmong:Hmnp Wancho:Wcho Yezidi:Yezi Chorasmian:Chrs Dives_Akuru:Diak '
    'Khitan_Small_Script:Kits Vithkuqi:Vith Old_Uyghur:Ougr Cypro_Minoan:Cpmn Tangsa:Tnsa '
    'Toto Kawi Nag_Mundari:Nagm'
).split():
    _name, _, _alias = _entry.partition(':')
    SCRIPTS[_name.upper()] = _name
    if _alias:
        SCRIPTS[_alias.upper()] = _name
#: How Java spells a property this module writes, where it differs.
JAVA_PROPS = {'Alphabetic': 'IsAlphabetic'}
MAX_COUNT = 1000


def _fail(message: str):
    raise PatternError(message)


# ---- ranges -----------------------------------------------------------------

def _normalize(ranges):
    out: List[List[int]] = []
    for lo, hi in sorted(ranges):
        if out and lo <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], hi)
        else:
            out.append([lo, hi])
    return [(lo, hi) for lo, hi in out]


def _complement(ranges):
    out = []
    nxt = 0
    for lo, hi in _normalize(ranges):
        if lo > nxt:
            out.append((nxt, lo - 1))
        nxt = hi + 1
    if nxt <= MAX_CP:
        out.append((nxt, MAX_CP))
    return out


def _in_ranges(ranges, cp):
    return any(lo <= cp <= hi for lo, hi in ranges)


_FOLD_CLASSES = [[ord(c) for c in cls] for cls in FOLDS]


def _folded(ranges):
    extra = []
    for cls in _FOLD_CLASSES:
        if any(_in_ranges(ranges, cp) for cp in cls):
            extra.extend((cp, cp) for cp in cls)
    return _normalize(list(ranges) + extra)


def _set(negated=False, lits=(), fixed=(), props=(), ci=False):
    lits = list(lits)
    return {'t': 'set', 'negated': negated,
            'ranges': _normalize((_folded(lits) if ci else lits) + list(fixed)),
            'props': list(props)}


# ---- parsing (Java syntax) --------------------------------------------------

def _is_digit(c):
    return c is not None and 0x30 <= c <= 0x39


def _is_hex(c):
    return c is not None and (_is_digit(c) or 0x41 <= c <= 0x46 or 0x61 <= c <= 0x66)


def _is_ascii_letter(c):
    return c is not None and (0x41 <= c <= 0x5A or 0x61 <= c <= 0x7A)


_ASSERTIONS = {'start', 'end', 'dollar', 'wordb'}
_QUANT = {0x2A, 0x2B, 0x3F, 0x7B}


class _Parser:
    def __init__(self, pattern: str, case_insensitive: bool):
        self.cps = [ord(c) for c in pattern]
        self.i = 0
        self.flags = {'ci': case_insensitive, 'dotall': False}
        self.group_count = 0
        self.group_names = {}

    def peek(self, k=0):
        j = self.i + k
        return self.cps[j] if j < len(self.cps) else None

    def at_end(self):
        return self.i >= len(self.cps)

    def take(self):
        c = self.cps[self.i]
        self.i += 1
        return c

    def char_node(self, cp):
        if self.flags['ci']:
            return _set(lits=[(cp, cp)], ci=True)
        return {'t': 'char', 'cp': cp}

    def read_hex(self, n):
        v = 0
        for _ in range(n):
            c = self.peek()
            if not _is_hex(c):
                _fail('\\x and \\u take hex digits.')
            v = v * 16 + int(chr(c), 16)
            self.i += 1
        return v

    def index_of(self, cp):
        try:
            return self.cps.index(cp, self.i)
        except ValueError:
            return -1

    def text(self, a, b):
        return ''.join(chr(c) for c in self.cps[a:b])

    def prop(self, negated):
        if self.peek() == 0x7B:
            close = self.index_of(0x7D)
            if close < 0:
                _fail('Unclosed \\p{.')
            name = self.text(self.i + 1, close)
            self.i = close + 1
        else:
            if self.at_end():
                _fail('\\p needs a category, such as \\p{L}.')
            name = chr(self.take())
        shown = f"\\{'P' if negated else 'p'}{{{name}}}"
        # Java's reading: `key=value` with the key in any case, `In` a block,
        # `Is` a category or a script, and a bare name a category.
        key, eq, value = name.partition('=')
        key = key.lower() if eq else None

        def script(s):
            return SCRIPTS.get(s.upper())
        found = None
        if key in ('gc', 'general_category'):
            if value in CATEGORIES:
                found = value
        elif key in ('sc', 'script'):
            if script(value):
                found = f'sc={script(value)}'
        elif key in ('blk', 'block') or (key is None and name.startswith('In')):
            _fail(f'{shown} is a block, which is not supported. '
                  'Use a script such as \\p{IsCyrillic}.')
        elif key is None and name.startswith('Is'):
            rest = name[2:]
            if rest in CATEGORIES:
                found = rest
            elif script(rest):
                found = f'sc={script(rest)}'
        elif key is None and name in CATEGORIES:
            found = name
        if not found:
            _fail(f'{shown} is not supported. '
                  'Use a category such as \\p{L} or a script such as \\p{IsArabic}.')
        if self.flags['ci'] and found in CASED:
            _fail(f'{shown} cannot be used with (?i).')
        return {'name': found, 'negated': negated}

    def escape(self, in_class):
        if self.at_end():
            _fail('The pattern ends with a backslash.')
        c = self.take()
        name = chr(c)
        simple = {'t': 0x09, 'n': 0x0A, 'r': 0x0D, 'f': 0x0C, 'a': 0x07, 'e': 0x1B}
        if name in simple:
            return {'cp': simple[name]}
        if name == '0':
            def octal(k):
                d = self.peek(k)
                return d is not None and 0x30 <= d <= 0x37
            if not octal(0):
                _fail('\\0 takes octal digits.')
            v = self.take() - 0x30
            if octal(0):
                v = v * 8 + (self.take() - 0x30)
                if octal(0) and v <= 0o37:
                    v = v * 8 + (self.take() - 0x30)
            return {'cp': v}
        if name == 'x':
            if self.peek() == 0x7B:
                self.i += 1
                v = 0
                n = 0
                while not self.at_end() and _is_hex(self.peek()):
                    v = v * 16 + int(chr(self.take()), 16)
                    n += 1
                    if v > MAX_CP:
                        _fail('\\x{..} is past the last code point.')
                if not n or self.peek() != 0x7D:
                    _fail('\\x{..} takes hex digits.')
                self.i += 1
                return {'cp': v}
            return {'cp': self.read_hex(2)}
        if name == 'u':
            v = self.read_hex(4)
            if 0xD800 <= v <= 0xDBFF and self.peek() == 0x5C and self.peek(1) == 0x75:
                self.i += 2
                lo = self.read_hex(4)
                if not 0xDC00 <= lo <= 0xDFFF:
                    _fail('A lone surrogate is not supported.')
                return {'cp': 0x10000 + ((v - 0xD800) << 10) + (lo - 0xDC00)}
            if 0xD800 <= v <= 0xDFFF:
                _fail('A lone surrogate is not supported.')
            return {'cp': v}
        if name == 'c':
            if self.at_end():
                _fail('\\c needs a character.')
            return {'cp': self.take() ^ 64}
        if name in ('d', 'D'):
            return {'fixed': [], 'props': [{'name': 'Nd', 'negated': name == 'D'}]}
        if name == 'w':
            return {'fixed': JOINERS, 'props': [{'name': n, 'negated': False} for n in WORD_PROPS]}
        if name == 'W':
            if in_class:
                _fail('\\W is not supported in [...]. Use [^\\w...] instead.')
            return {'negated_set': True, 'fixed': JOINERS,
                    'props': [{'name': n, 'negated': False} for n in WORD_PROPS]}
        if name in ESCAPE_SETS:
            return {'fixed': ESCAPE_SETS[name], 'props': []}
        if name in ('S', 'H', 'V'):
            return {'fixed': _complement(ESCAPE_SETS[name.lower()]), 'props': []}
        if name in ('p', 'P'):
            return {'fixed': [], 'props': [self.prop(name == 'P')]}
        if _is_digit(c) or _is_ascii_letter(c):
            if in_class:
                _fail(f'\\{name} is not supported in [...].')
            return self.escape_outside(c)
        return {'cp': c}

    def escape_outside(self, c):
        name = chr(c)
        if name == 'b':
            return {'node': {'t': 'wordb'}}
        if name == 'A':
            return {'node': {'t': 'start'}}
        if name == 'z':
            return {'node': {'t': 'end'}}
        if name == 'Z':
            return {'node': {'t': 'dollar'}}
        if name == 'Q':
            nodes = []
            while not self.at_end() and not (self.peek() == 0x5C and self.peek(1) == 0x45):
                nodes.append(self.char_node(self.take()))
            if not self.at_end():
                self.i += 2
            return {'nodes': nodes}
        if name == 'k':
            if self.peek() != 0x3C:
                _fail('\\k needs a group name, as in \\k<name>.')
            close = self.index_of(0x3E)
            if close < 0:
                _fail('Unclosed \\k<.')
            gname = self.text(self.i + 1, close)
            self.i = close + 1
            if gname not in self.group_names:
                _fail(f'No group named {gname}.')
            return {'node': self.backref(self.group_names[gname])}
        if 0x31 <= c <= 0x39:
            n = c - 0x30
            while not self.at_end() and _is_digit(self.peek()):
                nxt = n * 10 + (self.peek() - 0x30)
                if nxt > self.group_count:
                    break
                n = nxt
                self.i += 1
            if n > self.group_count:
                _fail(f'\\{n} refers to a group that does not exist.')
            return {'node': self.backref(n)}
        _fail(f'\\{name} is not supported.')

    def backref(self, n):
        if self.flags['ci']:
            _fail('A back reference cannot be used with (?i).')
        return {'t': 'backref', 'n': n}

    def parse_class(self):
        negated = False
        if self.peek() == 0x5E:
            negated = True
            self.i += 1
        if self.peek() == 0x5D:
            _fail('Write \\] for a ] inside [...].')
        lits, fixed, props = [], [], []

        def single():
            c = self.peek()
            if c == 0x5B:
                _fail('Nested [...] is not supported. Write \\[ for a [.')
            if c == 0x26 and self.peek(1) == 0x26:
                _fail('&& in [...] is not supported.')
            self.i += 1
            if c == 0x5C:
                return self.escape(True)
            return {'cp': c}

        while True:
            if self.at_end():
                _fail('Unclosed [.')
            if self.peek() == 0x5D:
                self.i += 1
                break
            item = single()
            range_next = self.peek() == 0x2D and self.peek(1) is not None and self.peek(1) != 0x5D
            if 'cp' not in item:
                if range_next:
                    _fail('A range cannot start or end at a class like \\w.')
                fixed.extend(item['fixed'])
                props.extend(item['props'])
                continue
            if not range_next:
                lits.append((item['cp'], item['cp']))
                continue
            self.i += 1
            if self.at_end():
                _fail('Unclosed [.')
            hi = single()
            if 'cp' not in hi:
                _fail('A range cannot start or end at a class like \\w.')
            if hi['cp'] < item['cp']:
                _fail(f"{chr(item['cp'])}-{chr(hi['cp'])} is not a range.")
            lits.append((item['cp'], hi['cp']))
        return _set(negated=negated, lits=lits, fixed=fixed, props=props, ci=self.flags['ci'])

    def parse_flags(self):
        nxt = dict(self.flags)
        on = True
        letters = 0
        while True:
            if self.at_end():
                _fail('Unclosed group.')
            c = chr(self.peek())
            if c in (')', ':'):
                if not letters:
                    _fail('(? must be followed by a flag or a group kind.')
                break
            self.i += 1
            letters += 1
            if c == '-':
                on = False
            elif c == 'i':
                nxt['ci'] = on
            elif c == 's':
                nxt['dotall'] = on
            elif c == 'u':
                continue
            elif c == 'U' and on:
                # The server compiles every pattern with UNICODE_CHARACTER_CLASS.
                continue
            else:
                _fail(f"(?{'' if on else '-'}{c}) is not supported.")
        return nxt

    def parse_group(self):
        saved = self.flags
        if self.peek() == 0x3F:
            self.i += 1
            c, c1 = self.peek(), self.peek(1)
            if c == 0x3A:
                self.i += 1
                node = {'t': 'group', 'kind': 'nc'}
            elif c in (0x3D, 0x21):
                self.i += 1
                node = {'t': 'group', 'kind': 'la' if c == 0x3D else 'nla'}
            elif c == 0x3C and c1 in (0x3D, 0x21):
                self.i += 2
                node = {'t': 'group', 'kind': 'lb' if c1 == 0x3D else 'nlb'}
            elif c == 0x3C:
                self.i += 1
                close = self.index_of(0x3E)
                name = '' if close < 0 else self.text(self.i, close)
                if not (name and name[0].isascii() and name[0].isalpha()
                        and all(ch.isascii() and ch.isalnum() for ch in name)):
                    _fail('A group name is letters and digits.')
                if name in self.group_names:
                    _fail(f'Two groups are named {name}.')
                self.i = close + 1
                self.group_count += 1
                self.group_names[name] = self.group_count
                node = {'t': 'group', 'kind': 'cap', 'n': self.group_count, 'name': name}
            elif c == 0x3E:
                _fail('(?>...) is not supported.')
            else:
                nxt = self.parse_flags()
                if self.peek() == 0x29:
                    self.i += 1
                    self.flags = nxt
                    return None
                self.i += 1
                self.flags = nxt
                node = {'t': 'group', 'kind': 'nc'}
        else:
            self.group_count += 1
            node = {'t': 'group', 'kind': 'cap', 'n': self.group_count}
        node['body'] = self.parse_alt()
        if self.peek() != 0x29:
            _fail('Unclosed group.')
        self.i += 1
        self.flags = saved
        return node

    @staticmethod
    def is_assertion(n):
        return n['t'] in _ASSERTIONS or (n['t'] == 'group' and n['kind'] in ('la', 'nla', 'lb', 'nlb'))

    def quantifier(self):
        c = self.peek()
        if c == 0x2A:
            lo, hi = 0, None
        elif c == 0x2B:
            lo, hi = 1, None
        elif c == 0x3F:
            lo, hi = 0, 1
        elif c == 0x7B:
            j = self.i + 1

            def num():
                nonlocal j
                s = ''
                while j < len(self.cps) and _is_digit(self.cps[j]):
                    s += chr(self.cps[j])
                    j += 1
                return s
            a = num()
            b: Optional[str] = a
            if j < len(self.cps) and self.cps[j] == 0x2C:
                j += 1
                b = num() or None
            if a == '' or j >= len(self.cps) or self.cps[j] != 0x7D:
                _fail('Write \\{ for a {.')
            lo = int(a)
            hi = None if b is None else int(b)
            if lo > MAX_COUNT or (hi is not None and hi > MAX_COUNT):
                _fail(f'A count above {MAX_COUNT} is not supported.')
            if hi is not None and hi < lo:
                _fail(f'In {{{a},{b}}} the first number is larger.')
            self.i = j + 1
        else:
            return None
        if c != 0x7B:
            self.i += 1
        lazy = False
        if self.peek() == 0x3F:
            lazy = True
            self.i += 1
        elif self.peek() == 0x2B:
            _fail('Possessive quantifiers (*+, ++, ?+) are not supported.')
        return {'min': lo, 'max': hi, 'lazy': lazy}

    def nothing_to_repeat(self, c):
        _fail(f'Nothing to repeat before {chr(c)}. Write \\{chr(c)} for the character.')

    def parse_seq(self):
        items = []
        while not self.at_end():
            c = self.peek()
            if c in (0x7C, 0x29):
                break
            self.i += 1
            if c == 0x28:
                g = self.parse_group()
                nodes = [g] if g else []
            elif c == 0x5B:
                nodes = [self.parse_class()]
            elif c == 0x2E:
                nodes = [_set(fixed=[(0, MAX_CP)]) if self.flags['dotall']
                         else _set(negated=True, fixed=LINE_END)]
            elif c == 0x5E:
                nodes = [{'t': 'start'}]
            elif c == 0x24:
                nodes = [{'t': 'dollar'}]
            elif c == 0x5C:
                e = self.escape(False)
                if 'cp' in e:
                    nodes = [self.char_node(e['cp'])]
                elif 'node' in e:
                    nodes = [e['node']]
                elif 'nodes' in e:
                    nodes = e['nodes']
                else:
                    nodes = [_set(negated=bool(e.get('negated_set')), fixed=e['fixed'], props=e['props'])]
            elif c in _QUANT:
                self.nothing_to_repeat(c)
            else:
                nodes = [self.char_node(c)]
            items.extend(nodes)
            if not self.at_end() and self.peek() in _QUANT:
                last = nodes[-1] if nodes else None
                if last is None or self.is_assertion(last):
                    self.nothing_to_repeat(self.peek())
                q = self.quantifier()
                if q:
                    items[-1] = {'t': 'rep', **q, 'body': last}
                    if not self.at_end() and self.peek() in _QUANT:
                        self.nothing_to_repeat(self.peek())
        return items[0] if len(items) == 1 else {'t': 'seq', 'items': items}

    def parse_alt(self):
        branches = [self.parse_seq()]
        while self.peek() == 0x7C:
            self.i += 1
            branches.append(self.parse_seq())
        return branches[0] if len(branches) == 1 else {'t': 'alt', 'branches': branches}

    def parse(self):
        ast = self.parse_alt()
        if not self.at_end():
            _fail('Unmatched ).')
        _check(ast)
        return ast


INF = float('inf')


def _max_length(node):
    t = node['t']
    if t in ('char', 'set'):
        return 1
    if t == 'seq':
        return sum(_max_length(n) for n in node['items'])
    if t == 'alt':
        return max(_max_length(n) for n in node['branches'])
    if t == 'rep':
        if node['max'] == 0:
            return 0
        return INF if node['max'] is None else node['max'] * _max_length(node['body'])
    if t == 'group':
        return _max_length(node['body']) if node['kind'] in ('cap', 'nc') else 0
    if t == 'backref':
        return INF
    return 0


def _check(ast):
    """A back reference must name a group that has certainly matched by then,
    and a lookbehind needs a bounded length (Java's rule)."""
    groups = {}

    def walk(node, conditional, in_behind):
        t = node['t']
        if t == 'seq':
            for n in node['items']:
                walk(n, conditional, in_behind)
        elif t == 'alt':
            for n in node['branches']:
                walk(n, True, in_behind)
        elif t == 'rep':
            walk(node['body'], conditional or node['min'] == 0, in_behind)
        elif t == 'group':
            look = node['kind'] not in ('cap', 'nc')
            behind = node['kind'] in ('lb', 'nlb')
            if behind and _max_length(node['body']) == INF:
                _fail('A lookbehind must have a bounded length.')
            if node['kind'] == 'cap':
                groups[node['n']] = {'closed': False, 'conditional': conditional}
            walk(node['body'], conditional or look, in_behind or behind)
            if node['kind'] == 'cap':
                groups[node['n']]['closed'] = True
        elif t == 'backref':
            g = groups.get(node['n'])
            if in_behind:
                _fail('A back reference inside a lookbehind is not supported.')
            if not g or not g['closed'] or g['conditional']:
                _fail(f"\\{node['n']} must refer to a group that always matches before it.")

    walk(ast, False, False)


# ---- writing it out ---------------------------------------------------------

#: Characters written as an escape rather than as themselves: controls,
#: spaces, format and invisible characters, surrogates and private use. A fixed
#: list, so the two clients write the same pattern whatever Unicode version each
#: one's tables know.
HIDDEN = [(0x80, 0x9f), (0xad, 0xad), (0x34f, 0x34f), (0x61c, 0x61c), (0x115f, 0x1160), (0x17b4, 0x17b5), (0x180b, 0x180f), (0x2000, 0x200f), (0x2028, 0x202f), (0x205f, 0x206f), (0x3000, 0x3000), (0x3164, 0x3164), (0xd800, 0xf8ff), (0xfe00, 0xfe0f), (0xfeff, 0xfeff), (0xffa0, 0xffa0), (0xfff0, 0xffff), (0x1d173, 0x1d17a), (0xe0000, 0xe0fff), (0xf0000, 0x10ffff)]


def _encode_char(cp, engine):
    if 0x30 <= cp <= 0x39 or _is_ascii_letter(cp) or cp == 0x5F:
        return chr(cp)
    if cp < 0x80:
        return f'\\x{cp:02x}'
    if not _in_ranges(HIDDEN, cp):
        return chr(cp)
    if engine == 'java':
        return f'\\x{{{cp:x}}}'
    return f'\\u{cp:04x}' if cp <= 0xFFFF else f'\\U{cp:08x}'


def _prop(p, engine):
    name = (engine == 'java' and JAVA_PROPS.get(p['name'])) or p['name']
    return f"\\{'P' if p['negated'] else 'p'}{{{name}}}"


def _encode_set(node, engine):
    ranges, props, negated = node['ranges'], node['props'], node['negated']
    if not ranges and len(props) == 1 and not negated:
        return _prop(props[0], engine)
    if not ranges and not props:
        return _encode_set({'ranges': [(0, MAX_CP)], 'props': [], 'negated': False}, engine) if negated else '(?!)'
    if not negated and not props and len(ranges) == 1 and ranges[0][0] == ranges[0][1]:
        return _encode_char(ranges[0][0], engine)
    out = '[^' if negated else '['
    for lo, hi in ranges:
        out += _encode_char(lo, engine)
        if hi > lo:
            out += ('-' if hi > lo + 1 else '') + _encode_char(hi, engine)
    for p in props:
        out += _prop(p, engine)
    return out + ']'


_END = {'java': '\\z', 'py': '\\Z'}

#: Java reads a pattern by UTF-16 units unless the pattern itself holds a
#: character outside the BMP: then its lookbehinds and \b step back a whole
#: code point, as JS and Python do. A branch that never matches, holding one
#: such character written as itself (an escape does not count), switches the
#: server's pattern to that reading (REV-W2 F2).
_SUPPLEMENTARY = '(?:(?!)' + chr(0x10FFFF) + ')?'
_WORD_SET = {'ranges': JOINERS, 'props': [{'name': n, 'negated': False} for n in WORD_PROPS],
             'negated': False}


def _is_atom(node, body):
    t = node['t']
    if t in ('group', 'backref', 'set'):
        return True
    if t == 'char':
        return len(body) == 1 or body.startswith('\\')
    return False


def _emit(node, engine):
    t = node['t']
    if t == 'char':
        return _encode_char(node['cp'], engine)
    if t == 'set':
        return _encode_set(node, engine)
    if t == 'start':
        return '^'
    if t == 'end':
        return _END[engine]
    if t == 'dollar':
        ends = _encode_set({'ranges': LINE_END, 'props': [], 'negated': False}, engine)
        return f'(?=(?:\\x0d\\x0a|{ends})?{_END[engine]})'
    if t == 'wordb':
        w = _encode_set(_WORD_SET, engine)
        return f'(?:(?<={w})(?!{w})|(?<!{w})(?={w}))'
    if t == 'backref':
        return f"(?:\\{node['n']})"
    if t == 'seq':
        return ''.join(_emit(n, engine) for n in node['items'])
    if t == 'alt':
        return '|'.join(_emit(n, engine) for n in node['branches'])
    if t == 'group':
        body = _emit(node['body'], engine)
        if node['kind'] == 'cap':
            if not node.get('name'):
                return f'({body})'
            return (f"(?P<{node['name']}>{body})" if engine == 'py'
                    else f"(?<{node['name']}>{body})")
        opener = {'nc': '(?:', 'la': '(?=', 'nla': '(?!', 'lb': '(?<=', 'nlb': '(?<!'}[node['kind']]
        return f'{opener}{body})'
    if t == 'rep':
        body = _emit(node['body'], engine)
        if not _is_atom(node['body'], body):
            body = f'(?:{body})'
        lo, hi = node['min'], node['max']
        if lo == 0 and hi is None:
            q = '*'
        elif lo == 1 and hi is None:
            q = '+'
        elif lo == 0 and hi == 1:
            q = '?'
        elif hi is None:
            q = f'{{{lo},}}'
        elif hi == lo:
            q = f'{{{lo}}}'
        else:
            q = f'{{{lo},{hi}}}'
        return body + q + ('?' if node['lazy'] else '')
    raise AssertionError(f'unknown node {t}')


def translate(pattern: str, *, literal: bool = False, case_insensitive: bool = False,
              whole: bool = False) -> Translated:
    """Read ``pattern`` as the server would and write it out for each engine.

    ``literal`` takes the text itself rather than a pattern, ``case_insensitive``
    is the same as a leading ``(?i)``, ``whole`` matches the whole value. Raises
    :class:`PatternError` for a pattern that is not supported or is too long
    for the server.
    """
    if literal:
        items = [(_set(lits=[(ord(c), ord(c))], ci=True) if case_insensitive
                  else {'t': 'char', 'cp': ord(c)}) for c in pattern]
        ast = items[0] if len(items) == 1 else {'t': 'seq', 'items': items}
    else:
        ast = _Parser(pattern, case_insensitive).parse()

    def wrap(engine):
        body = _emit(ast, engine)
        return f'^(?:{body}){_END[engine]}' if whole else body

    server = wrap('java') + _SUPPLEMENTARY
    # The server counts UTF-16 units.
    if len(server.encode('utf-16-le')) // 2 > SERVER_PATTERN_MAX:
        _fail(f'The pattern is too long. The limit is {SERVER_PATTERN_MAX} characters, and each '
              r'\b, \s, \w, $ or . counts as 30 to 230.')
    return Translated(server, wrap('py'))


@functools.lru_cache(maxsize=256)
def compile_local(pattern: str, *, literal: bool = False, case_insensitive: bool = False,
                  whole: bool = False):
    """The local half of :func:`translate`, compiled (``regex`` package)."""
    return regex.compile(translate(pattern, literal=literal, case_insensitive=case_insensitive,
                                   whole=whole).local)


def nfc(s: str) -> str:
    """``s`` in Unicode NFC, the same object when it already is."""
    return s if unicodedata.is_normalized('NFC', s) else unicodedata.normalize('NFC', s)


def nfd(s: str) -> str:
    """``s`` in Unicode NFD, the same object when it already is."""
    return s if unicodedata.is_normalized('NFD', s) else unicodedata.normalize('NFD', s)


def holds_mark(s: str) -> bool:
    """Whether ``s`` holds a combining mark (general category Mn, Mc or Me)."""
    return any(unicodedata.category(c) in ('Mn', 'Mc', 'Me') for c in s)


_MARK_PROPERTIES = frozenset({'m', 'mn', 'mc', 'me', 'mark', 'combiningmark', 'nonspacingmark',
                              'spacingmark', 'enclosingmark'})


def _mark_property(name: str) -> bool:
    """Whether ``\\p{name}`` names the combining marks: a mark category, or a
    block of combining marks, however Java lets it be spelled."""
    n = name.lower().replace('_', '').replace(' ', '').replace('-', '')
    for prefix in ('generalcategory=', 'gc=', 'block=', 'blk='):
        if n.startswith(prefix):
            n = n[len(prefix):]
            break
    if n.startswith('is'):
        n = n[2:]
    if n.startswith('in'):
        n = n[2:]
    return n in _MARK_PROPERTIES or n.startswith('combining')


_ASCII_ALNUM = frozenset('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ')


def _is_mark(cp: int) -> bool:
    return unicodedata.category(chr(cp)) in ('Mn', 'Mc', 'Me')


def _hex_escape(src: str, i: int):
    """At ``src[i]`` a backslash then x or u: the code point and the index
    after the escape, or None."""
    kind = src[i + 1]
    if kind == 'x' and src[i + 2:i + 3] == '{':
        j = src.find('}', i + 3)
        digits = src[i + 3:j] if j > 0 else ''
        end = j + 1
    else:
        width = 2 if kind == 'x' else 4
        digits = src[i + 2:i + 2 + width]
        end = i + 2 + width
        if len(digits) != width:
            return None
    if not digits or any(c not in '0123456789abcdefABCDEF' for c in digits) or int(digits, 16) > 0x10FFFF:
        return None
    return int(digits, 16), end


_TRIMMED = ''.join(chr(c) for c in range(0x21))


def _name_escape(src: str, i: int):
    """At ``src[i]`` a backslash then ``N{name}``: the code point and the
    index after the escape for a name Java knows (its character's name, any
    case, without an alias), or None."""
    if src[i + 2:i + 3] != '{':
        return None
    j = src.find('}', i + 3)
    if j < 0:
        return None
    # Java trims what String.trim does (up to U+0020) and ignores case.
    name = src[i + 3:j].strip(_TRIMMED).upper()
    try:
        ch = unicodedata.lookup(name)
    except KeyError:
        return None
    if len(ch) != 1 or unicodedata.name(ch, '') != name:
        return None
    return ord(ch), j + 1


def names_mark(src: str) -> bool:
    """Whether a Java pattern names a combining mark: it holds one, an escape
    of one (``\\x{301}``, ``\\u0301``, ``\\N{COMBINING ACUTE ACCENT}``), a
    class range between two, or a mark property (``\\p{M}``, ``\\p{Mn}``,
    ``\\pM``) on its own or in a class of nothing but mark properties, or a
    negated class of nothing but negated ones (``[^\\P{M}]``). Such
    a pattern also reaches inside composed letters (REV7-CORE-4), as one
    typed with the mark does. ``.``, ``\\w`` or ``[\\p{L}\\p{M}]`` match a
    mark too, but name none, so ``a.`` never finds the a inside á. The same
    scan as core's ``plaid.util.canonical/names-mark?`` and plaid-ui's
    ``namesMark``, and the clients ask it of the pattern they send
    (:func:`translate`'s ``server``), so they decide as the server does."""
    if holds_mark(src):
        return True
    i, n = 0, len(src)
    classes = []      # per open class: [negated, holds a mark property, holds anything else,
                      # holds a negated mark property]
    start = None      # in a class, the code point a range may start from
    dash = False      # in a class, a range's dash was read after `start`
    while i < n:
        c = src[i]
        cp = None
        if c == '\\':
            if i + 1 >= n:
                break
            e = src[i + 1]
            if e == 'Q':
                j = src.find('\\E', i + 2)
                i = n if j < 0 else j + 2
            elif e in 'xu' and (hit := _hex_escape(src, i)) is not None:
                cp, i = hit
            elif e == 'N' and (hit := _name_escape(src, i)) is not None:
                cp, i = hit
            elif e in 'pP':
                if src[i + 2:i + 3] == '{':
                    j = src.find('}', i + 3)
                    name, i = (src[i + 3:j], j + 1) if j > 0 else ('', n)
                else:
                    name, i = src[i + 2:i + 3], i + 3
                if _mark_property(name):
                    if not classes:
                        if e == 'P':
                            continue
                        return True
                    classes[-1][1 if e == 'p' else 3] = True
                    start, dash = None, False
                    continue
            else:
                cp = None if src[i + 1] in _ASCII_ALNUM else ord(src[i + 1])
                i += 2
                if cp is not None and not classes:
                    cp = None
        elif c == '[':
            i += 1
            negated = src[i:i + 1] == '^'
            classes.append([negated, False, False, False])
            if negated:
                i += 1
            start, dash = None, False
            continue
        elif c == ']' and classes:
            negated, marks, other, not_marks = classes.pop()
            if not other and ((not_marks and not marks) if negated else (marks and not not_marks)):
                return True
            i += 1
            start, dash = None, False
        elif c == '-' and classes and start is not None and not dash and src[i + 1:i + 2] not in ('', ']'):
            dash = True
            i += 1
            continue
        else:
            cp = ord(c) if classes else None
            i += 1
        if not classes:
            if cp is not None and _is_mark(cp):
                return True
            continue
        classes[-1][2] = True
        if cp is None:
            start, dash = None, False
        elif dash:
            if _is_mark(start) and _is_mark(cp):
                return True
            start, dash = None, False
        elif src[i:i + 1] == '-' and src[i + 1:i + 2] not in ('', ']'):
            start = cp
        else:
            if _is_mark(cp):
                return True
            start = None
    return False


def compile_decomposed(pattern: str, **kw):
    """``pattern`` decomposed (:func:`decompose_pattern`, in NFD outside its
    classes), compiled, when the pattern sent to the server for it names a
    combining mark (:func:`names_mark`), else None (and None when
    decomposing makes it a pattern that cannot be used). The server's REGEXP
    also matches such a pattern decomposed with the value in NFD, so a tone
    mark searched for on its own, typed or by escape, finds it inside a
    composed letter (Luke, 2026-10-16)."""
    try:
        sent = translate(pattern, **kw).server
    except PatternError:
        return None
    if not names_mark(sent):
        return None
    try:
        return compile_local(nfd(pattern) if kw.get('literal') else decompose_pattern(pattern), **kw)
    except PatternError:
        return None


def _quantifier_at(src: str, i: int) -> bool:
    """Whether a quantifier starts at ``src[i]``: ``*``, ``+``, ``?``, or
    ``{`` and a digit."""
    c = src[i:i + 1]
    return c in ('*', '+', '?') or (c == '{' and src[i + 1:i + 2] in tuple('0123456789'))


def _decomposes(c: str) -> bool:
    return nfd(c) != c


def _escape_end(src: str, i: int) -> int:
    r"""The index after the escape at ``src[i]`` (a backslash): through the
    braces of ``\x{..}``, ``\p{..}``, ``\P{..}`` and ``\N{..}``, the digits
    of ``\xhh`` and ``\uhhhh``, else the one character after the
    backslash."""
    n = len(src)
    e = src[i + 1:i + 2]
    if e in ('x', 'u') and (hit := _hex_escape(src, i)) is not None:
        return hit[1]
    if e in ('p', 'P', 'N', 'x') and src[i + 2:i + 3] == '{':
        j = src.find('}', i + 3)
        return n if j < 0 else j + 1
    return min(n, i + 2)


def _class_start(src: str, i: int) -> int:
    """The index of the first member of the class opening at ``src[i]``:
    after the ``[`` and a ``^``, and after a ``]`` there, which Java reads as
    itself."""
    k = i + 2 if src[i + 1:i + 2] == '^' else i + 1
    return k + 1 if src[k:k + 1] == ']' else k


def _class_end(src: str, i: int) -> int:
    """The index after the ``]`` that closes the class opening at ``src[i]``,
    or ``len(src)`` when none does."""
    n = len(src)
    k = _class_start(src, i)
    depth = 1
    while k < n:
        c = src[k]
        if c == '\\' and src[k + 1:k + 2] == 'Q':
            j = src.find('\\E', k + 2)
            if j < 0:
                return n
            k = j + 2
        elif c == '\\':
            k = _escape_end(src, k)
        elif c == '[':
            depth += 1
            k = _class_start(src, k)
        elif c == ']':
            if depth == 1:
                return k + 1
            depth -= 1
            k += 1
        else:
            k += 1
    return n


def _nfd_class(src: str, i: int, j: int) -> str:
    """The class at ``src[i:j]`` with every character in it decomposed,
    escapes and the two ends of a range as written."""
    out = []
    k = i
    while k < j:
        c = src[k]
        if c == '\\' and src[k + 1:k + 2] == 'Q':
            e = src.find('\\E', k + 2)
            end = j if e < 0 or e >= j else e
            out.append('\\Q' + nfd(src[k + 2:end]))
            if end < j:
                out.append('\\E')
                k = end + 2
            else:
                k = j
        elif c == '\\':
            e = min(j, _escape_end(src, k))
            out.append(src[k:e])
            k = e
        elif src[k + 1:k + 2] == '-' and k + 2 < j and src[k + 2] not in '][\\':
            # a range: its ends stay as written
            out.append(src[k:k + 3])
            k += 3
        elif src[k + 1:k + 2] == '-' and k + 2 < j and src[k + 2] == '\\':
            out.append(src[k:k + 2])
            k += 2
        else:
            out.append(nfd(c))
            k += 1
    return ''.join(out)


def _class_parts(src: str, i: int, j: int):
    """The class at ``src[i:j]`` as it matches a value in NFD: as written, but
    for a negated class inside it, which is decomposed. Also the composed
    letters it holds as members of its own (not a range's end, nor in a class
    with ``&&``), each decomposed, or None when there are none, and whether
    it holds a class or ``&&``: ``(pulled, text, nested)``."""
    neg = src[i + 1:i + 2] == '^'
    out = ['[^' if neg else '[']
    close = j - 1 if i + 1 < j and src[j - 1] == ']' else j
    pulled: List[str] = []
    k = i + 2 if neg else i + 1
    expect_dash = after_dash = no_pull = nested = False

    def member(c, nxt):
        start = src[nxt:nxt + 1] == '-' and src[nxt + 1:nxt + 2] not in ('', ']')
        if c is not None and not start and not after_dash and _decomposes(c):
            pulled.append(nfd(c))
        return start

    while k < close:
        c = src[k]
        if c == '\\' and src[k + 1:k + 2] == 'Q':
            e = src.find('\\E', k + 2)
            end = close if e < 0 or e >= close else e
            nxt = end + 2 if end < close else close
            pulled.extend(nfd(q) for q in src[k + 2:end] if _decomposes(q))
            out.append(src[k:nxt])
            k, expect_dash, after_dash = nxt, False, False
        elif c == '\\':
            e = min(close, _escape_end(src, k))
            x = src[k + 1:k + 2]
            if x in ('x', 'u') and (hit := _hex_escape(src, k)) is not None:
                cp = chr(hit[0])
            elif x == '' or x in _ASCII_ALNUM:
                cp = None
            else:
                cp = x
            out.append(src[k:e])
            if cp is not None:
                expect_dash = member(cp, e)
            else:
                expect_dash = False
            after_dash = False
            k = e
        elif c == '[':
            e = min(close, _class_end(src, k))
            out.append(_nfd_class(src, k, e) if src[k + 1:k + 2] == '^' else _class_parts(src, k, e)[1])
            k, expect_dash, after_dash, nested = e, False, False, True
        elif c == '&' and src[k + 1:k + 2] == '&':
            out.append('&&')
            k, expect_dash, after_dash, no_pull = k + 2, False, False, True
        elif c == '-' and expect_dash:
            out.append('-')
            k, expect_dash, after_dash = k + 1, False, True
        else:
            out.append(c)
            expect_dash = member(c, k + 1)
            after_dash = False
            k += 1
    if close < j:
        out.append(']')
    return (None if no_pull or not pulled else pulled), ''.join(out), nested or no_pull


def decompose_pattern(src: str) -> str:
    r"""The Java pattern ``src`` as it matches a value in NFD when
    :func:`names_mark` says so: decomposed (NFD) outside its character
    classes, so a mark it names finds the mark inside a composed letter. A
    composed letter under a quantifier is decomposed as a group (``é+`` is
    ``(?:é)+``). A class keeps its composed letters (REV8-CORE-1):
    ``[á\x{301}]`` holds á and the acute, never a plain a, and is
    ``(?:á|[á\x{301}])``, so it finds á whole and the acute inside
    ``ấ``, but not the a of ``ma``. A negated class is preceded by a
    lookahead for its composed letters decomposed, so ``[^á\x{301}]`` is
    ``(?:(?!a\u0301)[^á\x{301}])``: it finds the a of ``ma``, never the a of
    á. A negated class holding a class or ``&&``, and every negated class
    inside a class, is decomposed whole. An escape stays as written. The same rewriting as core's
    ``plaid.util.canonical/decompose-pattern`` and plaid-ui's
    ``decomposePattern``."""
    out: List[str] = []
    run: List[str] = []

    def flush():
        if run:
            out.append(nfd(''.join(run)))
            run.clear()

    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == '\\' and src[i + 1:i + 2] == 'Q':
            j = src.find('\\E', i + 2)
            end, nxt = (n, n) if j < 0 else (j, j + 2)
            body = src[i + 2:end]
            flush()
            last = body[-1:]
            if last and _quantifier_at(src, nxt) and _decomposes(last):
                out.append('\\Q' + nfd(body[:-1]) + '\\E(?:\\Q' + nfd(last) + '\\E)')
            else:
                out.append('\\Q' + nfd(body) + ('' if j < 0 else '\\E'))
            i = nxt
        elif c == '\\':
            e = _escape_end(src, i)
            flush()
            out.append(src[i:e])
            i = e
        elif c == '[':
            e = _class_end(src, i)
            flush()
            pulled, text, nested = _class_parts(src, i, e)
            alts = '|'.join(sorted(dict.fromkeys(pulled), key=lambda a: -len(a))) if pulled else None
            if src[i + 1:i + 2] != '^':
                out.append('(?:' + alts + '|' + text + ')' if alts else text)
            elif nested:
                out.append(_nfd_class(src, i, e))
            else:
                out.append('(?:(?!' + alts + ')' + text + ')' if alts else text)
            i = e
        else:
            if run and _quantifier_at(src, i) and _decomposes(run[-1]):
                last = run.pop()
                flush()
                out.append('(?:' + nfd(last) + ')')
            run.append(c)
            i += 1
    flush()
    return ''.join(out)


def compile_pair(pattern: str, **kw):
    """``pattern`` compiled as typed and in NFC, as the server's REGEXP reads
    it: a value matches as stored, or in NFC with the pattern in NFC. The NFC
    one is the first when the pattern already is NFC, or when composing makes
    it a pattern that cannot be used. Raises :class:`PatternError` for a
    pattern that cannot be used as typed."""
    raw = compile_local(pattern, **kw)
    composed = nfc(pattern)
    if composed is pattern:
        return raw, raw
    try:
        return raw, compile_local(composed, **kw)
    except PatternError:
        return raw, raw


def matcher(pattern: str, *, literal: bool = False, case_insensitive: bool = False,
            whole: bool = False) -> Callable[[Optional[str]], bool]:
    """Whether a value holds a match, exactly as the server's search decides
    it: as stored, or in NFC with the pattern in NFC, so text matches whatever
    is canonically equivalent to it (``pʰá`` typed composed and stored
    decomposed) and a mark searched for on its own still finds it stored as a
    mark. A pattern holding a combining mark also matches in NFD with the
    value in NFD (:func:`compile_decomposed`). Raises :class:`PatternError`
    for a pattern that cannot be used."""
    kw = dict(literal=literal, case_insensitive=case_insensitive, whole=whole)
    raw, composed = compile_pair(pattern, **kw)
    decomposed = compile_decomposed(pattern, **kw)

    def match(value: Optional[str]) -> bool:
        v = value or ''
        if raw.search(v) is not None:
            return True
        n = nfc(v)
        if (composed is not raw or n is not v) and composed.search(n) is not None:
            return True
        return decomposed is not None and decomposed.search(nfd(v)) is not None
    return match
