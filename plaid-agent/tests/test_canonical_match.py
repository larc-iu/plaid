"""Text matches whatever is canonically equivalent to it (H10-SCRIPTS-5): a
pattern typed composed finds a value stored decomposed and the reverse, as the
server's search does since it reads both in NFC. A replacement rewrites only
the place the match covers, mapped back onto the stored value by code point,
with the replacement as typed.
"""

from plaid_agent.core.java_regex import decompose_pattern, matcher, names_mark
from plaid_agent.core.replace import replacer

from test_igt_rules import _replace, _ws

NFD = 'pʰá.PL'

#: (pattern, names a mark), shared word for word with core's
#: plaid.util.canonical-test and plaid-ui's javaRegex.test.js.
NAMES_MARK_CASES = [
    ('́', True), (r'\x{301}', True), (r'\u0301', True), (r'\x{0301}', True), ('[́]', True),
    (r'[\x{300}-\x{36f}]', True), ('[̀-ͯ]', True), (r'\p{M}', True), (r'\p{Mn}', True),
    ('a|́', True), (r'\Q' + '́' + r'\E', True), (r'\pM', True), (r'\p{IsMn}', True),
    (r'\p{gc=Mc}', True), (r'\p{InCombiningDiacriticalMarks}', True), (r'\p{Mark}', True),
    (r'\p{general_category=Nonspacing_Mark}', True), (r'[\p{Mn}\p{Me}]', True), (r'[a\x{301}]', True),
    (r'[\p{M}]', True), (r'[[\p{M}]a]', True), (r'\x30' + '́', True),
    ('a', False), ('a.', False), (r'\w', False), ('[a-z]', False), (r'\p{L}', False), (r'\P{M}', False),
    (r'\\x{301}', False), (r'\x41', False), (r'[\x{2f0}-\x{310}]', False), (r'\p{IsLatin}', False),
    ('[a-]', False), (r'\x{zz}', False), (r'[^\p{Me}]', False), (r'\x{110000}', False), (r'\x{1F600}', False),
    (r'[\p{L}\p{M}]', False), (r'\b', False), (r'\W', False), (r'a\w', False), (r'[^\x{301}]', True),
    (r'[\x{2ff}-\x{370}]', False),
    # REV8-CORE-6
    (r'\N{COMBINING ACUTE ACCENT}', True), (r'\N{combining acute accent}', True),
    (r'[\N{COMBINING GRAVE ACCENT}a]', True), (r'\N{LATIN SMALL LETTER A WITH ACUTE}', False),
    (r'\N{NO SUCH NAME}', False), (r'[^\P{M}]', True), (r'[^\P{Mn}]', True), (r'[^\P{M}a]', False),
    (r'[\P{M}]', False), (r'\P{M}', False), (r'[^\P{M}\p{M}]', False),
]

#: (pattern, as it matches a value in NFD), shared word for word with core's
#: plaid.util.names-mark-test and plaid-ui's javaRegex.test.js (REV8-CORE-1).
DECOMPOSED_CASES = [
    ('\u00e1', 'a\u0301'),
    ('x\u00e1y', 'xa\u0301y'),
    ('[\u00e1\\x{301}]', '(?:a\u0301|[\u00e1\\x{301}])'),
    ('[\u00f3\u00fa\u0301]', '(?:o\u0301|u\u0301|[\u00f3\u00fa\u0301])'),
    ('[^\u00e1\\x{301}]', '(?:(?!a\u0301)[^\u00e1\\x{301}])'),
    ('[^\u00e1]+', '(?:(?!a\u0301)[^\u00e1])+'),
    ('[^\u00e1&&b]', '[^a\u0301&&b]'),
    ('[x[^\u00e1]]', '[x[^a\u0301]]'),
    ('[^x[\u00e1]]', '[^x[a\u0301]]'),
    ('[[\u00e1]\u00e9]', '(?:e\u0301|[[\u00e1]\u00e9])'),
    ('[\u00e1\u00e1]', '(?:a\u0301|[\u00e1\u00e1])'),
    ('[\u1ea5\u00e2]', '(?:a\u0302\u0301|a\u0302|[\u1ea5\u00e2])'),
    ('[\\x{e1}b]', '(?:a\u0301|[\\x{e1}b])'),
    ('[\\u00e1]', '(?:a\u0301|[\\u00e1])'),
    ('[\\\u00e1]', '(?:a\u0301|[\\\u00e1])'),
    ('[\u00e0-\u00fa]', '[\u00e0-\u00fa]'),
    ('[a-\u00fa\u00e9]', '(?:e\u0301|[a-\u00fa\u00e9])'),
    ('[\u00e1&&\\p{L}]', '[\u00e1&&\\p{L}]'),
    ('[\u00e1-]', '(?:a\u0301|[\u00e1-])'),
    ('[\\Q\u00e1]\\E]', '(?:a\u0301|[\\Q\u00e1]\\E])'),
    ('[\u00e1]+', '(?:a\u0301|[\u00e1])+'),
    ('\u00e9+', '(?:e\u0301)+'),
    ('\u00e9{2}', '(?:e\u0301){2}'),
    ('\u00e9*?', '(?:e\u0301)*?'),
    ('a\u00e9?', 'a(?:e\u0301)?'),
    ('(\u00e9)+', '(e\u0301)+'),
    ('\u00e9{x', 'e\u0301{x'),
    ('\\x{e9}+', '\\x{e9}+'),
    ('\\\u00e9', '\\\u00e9'),
    ('\\p{L}\u00e9', '\\p{L}e\u0301'),
    ('\\Q\u00e9\\E+', '\\Q\\E(?:\\Qe\u0301\\E)+'),
    ('\\Q\u00e1\u00e9\\E', '\\Qa\u0301e\u0301\\E'),
    ('\\Q\u00e1', '\\Qa\u0301'),
    ('\u1ea1\u0301', 'a\u0323\u0301'),
    ('\u00e1\u0323', 'a\u0323\u0301'),
    ('[]\u00e1]', '(?:a\u0301|[]\u00e1])'),
    ('[^]\u00e1]', '(?:(?!a\u0301)[^]\u00e1])'),
    ('[x[]\u00e1]]', '[x[]\u00e1]]'),
    ('[^x[\u00fa-\u1ea5\u00e1]]', '[^x[\u00fa-\u1ea5a\u0301]]'),
]


def rep(pattern, replacement, value, regex=False, whole=False):
    return replacer(pattern, replacement, regex, whole)(value)


def test_a_composed_pattern_finds_a_decomposed_value_and_the_reverse():
    assert matcher('pʰá')(NFD)
    assert matcher('pʰá')('pʰá')
    assert matcher('PʰÁ', case_insensitive=True)(NFD)
    # A bare letter is not found inside a composed accented one.
    assert not matcher('a.', literal=False)('p\u02b0\u00e1')


def test_every_match_the_stored_text_gives_is_kept():
    # REV-FX11: a mark searched for on its own (a high tone) still finds it
    # in a value stored decomposed, as the server's REGEXP does.
    assert matcher('\u0301')(NFD)
    assert matcher('\u0301')('\u014b\u0301')
    # A tone mark respelled on its own in a value stored decomposed, the
    # result composed as the server stores it.
    assert rep('\u0301', '\u0300', NFD) == 'p\u02b0\u00e0.PL'


def test_a_pattern_holding_a_mark_finds_it_inside_a_composed_letter():
    # Luke, 2026-10-16: a pattern holding a combining mark also matches with
    # pattern and value decomposed, as the server's REGEXP does.
    assert matcher('\u0301')('p\u02b0\u00e1')
    assert matcher('[\u0300\u0301]$', literal=False)('p\u02b0\u00e1')
    assert matcher('A\u0301', case_insensitive=True)('p\u02b0\u00e1')
    # REV7-CORE-4: a mark named by escape or by its category reaches inside
    # a letter too, while a pattern naming none never looks inside one.
    for named in (r'\p{M}', r'\p{Mn}', r'\pM', r'\x{301}', r'\u0301', r'[\x{300}-\x{36f}]$', r'[\p{Mn}\p{Me}]'):
        assert matcher(named, literal=False)('p\u02b0\u00e1'), named
        assert rep(named, '', 'p\u02b0\u00e1', regex=True) == 'p\u02b0a', named
    for unnamed in ('a', 'a.', r'a\w', r'a[\p{L}\p{M}]', r'a\P{L}'):
        assert not matcher(unnamed, literal=False)('p\u02b0\u00e1'), unnamed
    # Typed as literal text, an escape is the text itself.
    assert not matcher(r'\x{301}', literal=True)('p\u02b0\u00e1')


def test_names_mark_reads_a_pattern_as_core_does():
    # The same table as core's canonical-test and plaid-ui's javaRegex.test.js.
    for pattern, named in NAMES_MARK_CASES:
        assert names_mark(pattern) is named, pattern
    # Every acute is respelled, inside a composed letter or after one that
    # has no composed form, and the value comes back composed.
    assert rep('\u0301', '\u0300', '\u014b\u0301 p\u02b0\u00e1') == '\u014b\u0300 p\u02b0\u00e0'
    assert rep('\u0301', '', 'p\u02b0\u00e1') == 'p\u02b0a'
    assert rep('(.)\u0301', r'\1\u0302', 'p\u02b0\u00e1', regex=True) == 'p\u02b0\u00e2'
    # A letter matches inside a decomposed one as stored, as it always has.
    assert matcher('a.', literal=False)('p\u02b0a\u0301')


def test_decompose_pattern_keeps_class_letters_as_core_does():
    for pattern, want in DECOMPOSED_CASES:
        assert decompose_pattern(pattern) == want, pattern


def test_a_mark_pattern_never_finds_a_base_letter_it_does_not_name():
    # REV8-CORE-1: `[á\x{301}]` was decomposed as a whole, so it held a
    # plain a: it found a and ma, and `[óú\x{301}]` replaced by nothing
    # deleted every o.
    values = ['\u00e1', '\u00e0', 'a', '\u1ea5', 'e', '\u00e9', '\u1ea3', 'o', 'ma']
    for p in (r'[\u00e1\x{301}]', '[\u00e1\u0301]', r'[\u00f3\u00fa\x{301}]'):
        m = matcher(p, literal=False)
        assert [v for v in values if m(v)] == ['\u00e1', '\u1ea5', '\u00e9'], p
    assert rep(r'[\u00e1\x{301}]', 'X', 'a \u00e0 ma m\u00e0 m\u00e1', regex=True) == 'a \u00e0 ma m\u00e0 mX'
    assert rep(r'[\u00f3\u00fa\x{301}]', '', 'o \u00f2 m\u00e1 \u00f3', regex=True) == 'o \u00f2 ma '
    m = matcher(r'^[^\u00e1\x{301}]+$', literal=False)
    assert [v for v in values if m(v)] == [v for v in values if v != '\u00e1']
    m = matcher(r'^\u00e9+$|^\x{301}$', literal=False)
    assert [v for v in values if m(v)] == ['\u00e9']


def test_a_replacement_rewrites_the_place_it_matched_and_keeps_the_rest_as_stored():
    assert rep('pʰá', 'pʰa˥', NFD) == 'pʰa˥.PL'
    # The rest of the value keeps its decomposed spelling.
    assert rep('kat', 'cat', 'tékst kat') == 'tékst cat'
    assert rep('á', 'X', 'ŋ̃ pʰá') == 'ŋ̃ pʰX'
    # The replacement is written as typed, decomposed when typed so.
    assert rep('á', 'é', 'á') == 'é'
    # A group carries what it captured.
    assert rep(r'(p.)á', r'\1a', NFD, regex=True) == 'pʰa.PL'
    assert rep('a', 'o', 'pʰá') == 'pʰá'
    # A composed match comes first: both spellings in one value are rewritten.
    assert rep('á', 'X', 'á á') == 'X X'


def test_offsets_are_code_points_and_compositions_across_starters_map_whole():
    assert rep('é', 'E', '\U00010400é') == '\U00010400E'
    # Hangul jamo compose across two starters.
    assert rep('가', '나', '가x') == '나x'
    assert rep('x', 'y', '가x') == '가y'


def test_replace_in_field_finds_a_decomposed_gloss_typed_composed():
    store = {'sp-g1': NFD, 'sp-x2': 'pʰá', 'sp-x3': 'X', 'sp-y1': 'pʰa', 'sp-y2': 'X'}
    client, w = _ws(store)
    _replace(w, 'pʰá', 'pʰa˥')
    [row] = w.plan_payload()['changes']
    assert row['rule']['total'] == 2


def test_an_empty_match_moves_on_as_java_and_js_do():
    # REV-W2 nit 1: after an empty match the next search starts one place on,
    # so a pattern whose first alternative can match empty rewrites what
    # Java's find and igt's replacer rewrite ("a".replaceAll("|a", "X") is
    # "XaX"), not Python's own "XXX".
    assert rep('|a', 'X', 'a', regex=True) == 'XaX'
    assert rep('x*', '-', 'abc', regex=True) == '-a-b-c-'
    assert rep('a|', 'X', 'ab', regex=True) == 'XXbX'
