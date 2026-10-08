"""Characters a model wrote that it cannot have meant.

A model writes text as tokens, and a tokenizer that works on bytes has no token
for a letter of a rare script. So the model writes such a letter as two pieces,
one for its first three UTF-8 bytes and one for the last, and it does not always
get the first piece right. When it gets that piece wrong, the letter comes out in
another script that happens to be more common in what the model was trained on.
A Wancho word typed by GLM came out as Egyptian hieroglyphs, the last byte of every
letter intact, so the hieroglyphs shifted back by a fixed offset gave the word.
Sometimes the first piece comes out as bytes that are no character at all, which
decode to U+FFFD.

A value copied in code from what the project or a file holds never passes through
the model's writing, so it is never garbled this way. A value the model TYPES can
be. This module is the check made of what the model hands a plan tool, or
plan() and save_file() in run_code: a character outside the Basic Multilingual
Plane, or a broken one, of a kind that appears nowhere the turn could have copied
it from. A letter, a mark, a digit, a symbol, a private-use or an unassigned code
point: a wrong first piece can land on any of them. Only those planes are checked
because the common scripts are in the BMP and have tokens of their own, so a model
writes them reliably, and a translation into Hindi for a project that has none is
a real value. Emoji are typed whole, from tokens of their own, and are not checked.
Half a character (a lone surrogate) is refused always: nothing can store it.
"""

import re
from functools import lru_cache
from typing import Any, Callable, Iterable, Optional, Set

import regex

REPLACEMENT = '\ufffd'

# Every script Unicode names, by its long name, which ``regex`` (required
# already) knows the letters of. Python has no script property, and the first
# word of a character's name is not one: OLD is nine scripts, LINEAR two.
# Common, Inherited and Unknown are left out: they are no one script.
SCRIPTS = (
    'Adlam Ahom Anatolian_Hieroglyphs Arabic Armenian Avestan Balinese Bamum Bassa_Vah Batak Bengali '
    'Beria_Erfe Bhaiksuki Bopomofo Brahmi Braille Buginese Buhid Canadian_Aboriginal Carian '
    'Caucasian_Albanian Chakma Cham Cherokee Chorasmian Coptic Cuneiform Cypriot Cypro_Minoan Cyrillic '
    'Deseret Devanagari Dives_Akuru Dogra Duployan Egyptian_Hieroglyphs Elbasan Elymaic Ethiopic Garay '
    'Georgian Glagolitic Gothic Grantha Greek Gujarati Gunjala_Gondi Gurmukhi Gurung_Khema Han Hangul '
    'Hanifi_Rohingya Hanunoo Hatran Hebrew Hiragana Imperial_Aramaic Inscriptional_Pahlavi '
    'Inscriptional_Parthian Javanese Kaithi Kannada Katakana Kawi Kayah_Li Kharoshthi Khitan_Small_Script '
    'Khmer Khojki Khudawadi Kirat_Rai Lao Latin Lepcha Limbu Linear_A Linear_B Lisu Lycian Lydian Mahajani '
    'Makasar Malayalam Mandaic Manichaean Marchen Masaram_Gondi Medefaidrin Meetei_Mayek Mende_Kikakui '
    'Meroitic_Cursive Meroitic_Hieroglyphs Miao Modi Mongolian Mro Multani Myanmar Nabataean Nag_Mundari '
    'Nandinagari New_Tai_Lue Newa Nko Nushu Nyiakeng_Puachue_Hmong Ogham Ol_Chiki Ol_Onal Old_Hungarian '
    'Old_Italic Old_North_Arabian Old_Permic Old_Persian Old_Sogdian Old_South_Arabian Old_Turkic '
    'Old_Uyghur Oriya Osage Osmanya Pahawh_Hmong Palmyrene Pau_Cin_Hau Phags_Pa Phoenician Psalter_Pahlavi '
    'Rejang Runic Samaritan Saurashtra Sharada Shavian Siddham Sidetic SignWriting Sinhala Sogdian '
    'Sora_Sompeng Soyombo Sundanese Sunuwar Syloti_Nagri Syriac Tagalog Tagbanwa Tai_Le Tai_Tham Tai_Viet '
    'Tai_Yo Takri Tamil Tangsa Tangut Telugu Thaana Thai Tibetan Tifinagh Tirhuta Todhri Tolong_Siki Toto '
    'Tulu_Tigalari Ugaritic Vai Vithkuqi Wancho Warang_Citi Yezidi Yi Zanabazar_Square').split()

# How a script is written in a sentence, where its long name is not how.
_SPOKEN = {'Nko': "N'Ko", 'Phags_Pa': 'Phags-pa', 'Han': 'Han (Chinese characters)'}

# The blocks above the BMP whose characters belong to no one script (symbols,
# numbers, marks used by many). Each is a "script" of its own here, so reading
# a musical symbol vouches for musical symbols and not for mathematical letters.
_BLOCKS = (
    (0x10100, 0x1013F, 'Aegean Numbers'), (0x10190, 0x101CF, 'Ancient Symbols'),
    (0x101D0, 0x101FF, 'Phaistos Disc'), (0x102E0, 0x102FF, 'Coptic Epact Numbers'),
    (0x1BCA0, 0x1BCAF, 'Shorthand Format Controls'),
    (0x1CC00, 0x1CEBF, 'Symbols for Legacy Computing Supplement'),
    (0x1CEC0, 0x1CEFF, 'Miscellaneous Symbols Supplement'), (0x1CF00, 0x1CFCF, 'Znamenny Musical Notation'),
    (0x1D000, 0x1D0FF, 'Byzantine Musical Symbols'), (0x1D100, 0x1D1FF, 'Musical Symbols'),
    (0x1D2C0, 0x1D2DF, 'Kaktovik Numerals'), (0x1D2E0, 0x1D2FF, 'Mayan Numerals'),
    (0x1D300, 0x1D35F, 'Tai Xuan Jing Symbols'), (0x1D360, 0x1D37F, 'Counting Rod Numerals'),
    (0x1D400, 0x1D7FF, 'Mathematical Alphanumeric Symbols'), (0x1EC70, 0x1ECBF, 'Indic Siyaq Numbers'),
    (0x1ED00, 0x1ED4F, 'Ottoman Siyaq Numbers'), (0x1F000, 0x1F02F, 'Mahjong Tiles'),
    (0x1F030, 0x1F09F, 'Domino Tiles'), (0x1F0A0, 0x1F0FF, 'Playing Cards'),
    (0x1F100, 0x1F1FF, 'Enclosed Alphanumeric Supplement'), (0x1F200, 0x1F2FF, 'Enclosed Ideographic Supplement'),
    (0x1F300, 0x1F5FF, 'Miscellaneous Symbols and Pictographs'), (0x1F600, 0x1F64F, 'Emoticons'),
    (0x1F650, 0x1F67F, 'Ornamental Dingbats'), (0x1F680, 0x1F6FF, 'Transport and Map Symbols'),
    (0x1F700, 0x1F77F, 'Alchemical Symbols'), (0x1F780, 0x1F7FF, 'Geometric Shapes Extended'),
    (0x1F800, 0x1F8FF, 'Supplemental Arrows-C'), (0x1F900, 0x1F9FF, 'Supplemental Symbols and Pictographs'),
    (0x1FA00, 0x1FA6F, 'Chess Symbols'), (0x1FA70, 0x1FAFF, 'Symbols and Pictographs Extended-A'),
    (0x1FB00, 0x1FBFF, 'Symbols for Legacy Computing'), (0xE0000, 0xE007F, 'Tags'),
    (0xE0100, 0xE01EF, 'Variation Selectors Supplement'),
)

_SCRIPT_OF = regex.compile('|'.join(f'(?P<s{i}>\\p{{Script={n}}})' for i, n in enumerate(SCRIPTS)))
_COMMON = regex.compile(r'[\p{Script=Common}\p{Script=Inherited}]')
_PRIVATE = regex.compile(r'\p{Co}')
# What a model types whole, from tokens of their own: assigned emoji and the
# pieces a flag or a skin tone is built from.
_EMOJI = regex.compile(r'(?!\p{Cn})[\p{Extended_Pictographic}\p{Emoji_Component}]')
# What the check looks at: a broken character, half a character, or anything
# outside the BMP.
_CHECKED = re.compile('[\ud800-\udfff\ufffd\U00010000-\U0010ffff]')

BROKEN = 'broken'
PRIVATE = 'private'


@lru_cache(maxsize=1 << 16)
def key(ch: str) -> Optional[str]:
    """What reading ``ch`` vouches for, which is what typing it needs vouched:
    ``script:Wancho``, ``block:Musical Symbols``, ``private``, ``broken`` for a
    U+FFFD, or ``unknown:U+1E280`` for a code point no script is known for
    here (unassigned, or newer than this Unicode data), by the 128 it falls in.
    None for what is never in doubt: ASCII, a letter of a script with no
    character above the BMP, a symbol of the BMP, an emoji, half a character.

    Every letter of a script vouches for every other, in any plane: a project
    that holds one Han character can hold an Extension B one."""
    o = ord(ch)
    if o < 0x80 or 0xD800 <= o <= 0xDFFF:
        return None
    if ch == REPLACEMENT:
        return BROKEN
    if o > 0xFFFF and _EMOJI.match(ch):
        return None
    m = _SCRIPT_OF.match(ch)
    if m:
        return 'script:' + SCRIPTS[int(m.lastgroup[1:])]
    if o <= 0xFFFF:
        return None
    if _COMMON.match(ch):
        for lo, hi, name in _BLOCKS:
            if lo <= o <= hi:
                return 'block:' + name
    elif _PRIVATE.match(ch):
        return PRIVATE
    return f'unknown:U+{o & ~0x7F:04X}'


def _described(k: str, ch: str) -> str:
    """What a key is, in the words of a refusal: "letters of the Wancho script"."""
    if k.startswith('script:'):
        name = k[7:]
        return f'letters of the {_SPOKEN.get(name, name.replace("_", " "))} script'
    if k.startswith('block:'):
        return f'characters from {k[6:]}'
    if k == PRIVATE:
        return 'private-use characters'
    return f'a character no script is known for (U+{ord(ch):04X})'


def strings(value: Any) -> Iterable[str]:
    """Every string in a value: the value itself, or what a dict or list holds."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for k, v in value.items():
            yield from strings(k)
            yield from strings(v)
    elif isinstance(value, (list, tuple, set)):
        for v in value:
            yield from strings(v)


class Seen:
    """What the rare characters a turn could have copied from vouch for: the
    keys of :func:`key`, a script for the most part.

    Fed with what the turn was given (the stored conversation, apart from what the
    model itself wrote in it) and with everything its tools answered, the host
    functions of run_code included, so a value copied in code from a document that
    was never printed is still one the turn has seen. A string with nothing
    outside ASCII costs one scan in C.

    A file the assistant made vouches for nothing, since what it holds may have
    been typed. Code that reads one has what it read noted in ``made`` instead,
    and the run's printed answer is taken less those scripts (:meth:`take_made`).
    """

    def __init__(self):
        self.scripts: Set[str] = set()
        self.made: Set[str] = set()

    def add(self, value: Any, unless: Any = None, withheld: Optional[Set[str]] = None) -> Any:
        """Note the scripts in ``value``, and give it back unchanged.

        ``unless`` is what the model wrote to get ``value``: a tool's arguments,
        or the code that run_code ran. A script in it is not taken from the
        answer, since an answer can echo what it was asked (a search that found
        nothing names the form it looked for), and a garbled form echoed back
        is still garbled. ``withheld`` is more scripts not to take from it.
        """
        found = scripts_of(value)
        if unless is not None:
            found -= scripts_of(unless)
        if withheld:
            found -= withheld
        self.scripts |= found
        return value

    def add_made(self, value: Any) -> Any:
        """Note what code read from a file the assistant made: kept apart, and
        held against what the same run prints."""
        self.made |= scripts_of(value)
        return value

    def take_made(self) -> Set[str]:
        """The scripts code read from made files since the last call, which the
        run's answer may echo and must not vouch for."""
        out, self.made = self.made, set()
        return out


def scripts_of(value: Any) -> Set[str]:
    """What the characters in a value vouch for (see :func:`key`)."""
    out: Set[str] = set()
    for s in strings(value):
        if s.isascii():
            continue
        for ch in set(s):
            k = key(ch)
            if k is not None:
                out.add(k)
    return out


def _shown(s: str) -> str:
    """``s`` with each half character written as its code point, which a
    message can carry where the character itself cannot be encoded."""
    return re.sub('[\ud800-\udfff]', lambda m: f'<U+{ord(m.group()):04X}>', s)


def _excerpt(s: str, at: int) -> str:
    lo = max(0, at - 20)
    return _shown(('…' if lo else '') + s[lo:at + 20] + ('…' if at + 20 < len(s) else ''))


_COPY = ('Do not type it: copy it in run_code from the data that holds it (load, query or file_rows), and '
         'stage the change from there.')


def refusal(value: Any, seen: Seen, more: Optional[Callable[[], Iterable[str]]] = None) -> Optional[str]:
    """Why ``value`` may not be staged, or None.

    ``more`` gives further text the turn could copy from (the attached files), read
    only when a character is in doubt, so a plan with nothing rare in it never reads a
    four-megabyte table to find that out.
    """
    asked = False
    for s in strings(value):
        if s.isascii():
            continue
        for m in _CHECKED.finditer(s):
            ch, i = m.group(), m.start()
            if 0xD800 <= ord(ch) <= 0xDFFF:
                return (f'"{_excerpt(s, i)}" holds half of a character (U+{ord(ch):04X}) without its other '
                        'half, which cannot be stored. Write the whole character, or copy the value in '
                        'run_code from the data that holds it.')
            k = key(ch)
            if k is None or k in seen.scripts:
                continue
            if not asked and more is not None:
                asked = True
                for text in more():
                    seen.add(text)
                if k in seen.scripts:
                    continue
            if k == BROKEN:
                return (f'"{_excerpt(s, i)}" has a broken character in it (\ufffd), and nothing you have read '
                        'holds one. It is what a letter of a rare script becomes when it is typed out and '
                        f'comes out wrong. {_COPY}')
            return (f'"{_excerpt(s, i)}" has {_described(k, ch)}, which appear in nothing you have read that '
                    'it could have been copied from. A form in a rare script that is typed out often comes '
                    f'out in another script entirely. {_COPY} If it really is new text the user gave you, '
                    'ask them to paste it into the chat.')
    return None


def seed(seen: Seen, system: str, transcript: Iterable[dict],
         vouches: Optional[Callable[[str, Any], bool]] = None) -> None:
    """Note what a turn starts out able to copy from: the system prompt, every
    message of the user's, and every tool answer of earlier turns, each less
    what its own call asked (as :meth:`Seen.add` takes it live). What the model
    itself wrote is not a source: it may be garbled already.

    An answer is paired with its call among the calls of the assistant message
    just before it, by id, or by place when the ids are missing or repeated
    there: a provider may number its calls afresh each turn, or send none.
    ``vouches(name, arguments)`` is False for a call whose answer vouches for
    nothing (a read of a file the assistant made)."""
    seen.add(system)
    calls: list = []
    by_id: dict = {}
    at = 0
    for m in transcript:
        role = m.get('role')
        if role == 'assistant':
            calls = [((c.get('function') or {}).get('name'), _parsed((c.get('function') or {}).get('arguments')))
                     for c in m.get('tool_calls') or m.get('tool-calls') or [] if isinstance(c, dict)]
            ids = [c.get('id') for c in m.get('tool_calls') or m.get('tool-calls') or [] if isinstance(c, dict)]
            by_id = dict(zip(ids, calls)) if None not in ids and len(set(ids)) == len(ids) else {}
            at = 0
        elif role == 'user':
            seen.add(m.get('content'))
            calls, by_id, at = [], {}, 0
        elif role == 'tool':
            answer_id = m.get('tool_call_id') or m.get('tool-call-id')
            call = by_id.get(answer_id) if answer_id in by_id else (calls[at] if at < len(calls) else None)
            at += 1
            name, args = call if call else (None, None)
            if name is not None and vouches is not None and not vouches(name, args):
                continue
            seen.add(m.get('content'), unless=args)


def _parsed(arguments: Any) -> Any:
    """A call's arguments as the model wrote them, decoded: a provider may send
    them with every letter past ASCII escaped, which hides their script."""
    if isinstance(arguments, str):
        import json
        try:
            return json.loads(arguments)
        except ValueError:
            return arguments
    return arguments
