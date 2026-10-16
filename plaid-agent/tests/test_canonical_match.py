"""Text matches whatever is canonically equivalent to it (H10-SCRIPTS-5): a
pattern typed composed finds a value stored decomposed and the reverse, as the
server's search does since it reads both in NFC. A replacement rewrites only
the place the match covers, mapped back onto the stored value by code point,
with the replacement as typed.
"""

from plaid_agent.core.java_regex import matcher
from plaid_agent.core.replace import replacer

from test_igt_rules import _replace, _ws

NFD = 'pʰá.PL'


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
    # A class of marks names no mark, and a pattern with no mark never
    # looks inside a letter.
    assert not matcher(r'\p{M}', literal=False)('p\u02b0\u00e1')
    assert not matcher('a')('p\u02b0\u00e1')
    # Every acute is respelled, inside a composed letter or after one that
    # has no composed form, and the value comes back composed.
    assert rep('\u0301', '\u0300', '\u014b\u0301 p\u02b0\u00e1') == '\u014b\u0300 p\u02b0\u00e0'
    assert rep('\u0301', '', 'p\u02b0\u00e1') == 'p\u02b0a'
    assert rep('(.)\u0301', r'\1\u0302', 'p\u02b0\u00e1', regex=True) == 'p\u02b0\u00e2'
    # A letter matches inside a decomposed one as stored, as it always has.
    assert matcher('a.', literal=False)('p\u02b0a\u0301')


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
