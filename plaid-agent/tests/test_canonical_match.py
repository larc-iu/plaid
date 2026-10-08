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
    # A bare letter is not found inside an accented one.
    assert not matcher('a.', literal=False)(NFD.replace('.PL', ''))


def test_a_replacement_rewrites_the_place_it_matched_and_keeps_the_rest_as_stored():
    assert rep('pʰá', 'pʰa˥', NFD) == 'pʰa˥.PL'
    # The rest of the value keeps its decomposed spelling.
    assert rep('kat', 'cat', 'tékst kat') == 'tékst cat'
    assert rep('á', 'X', 'ŋ̃ pʰá') == 'ŋ̃ pʰX'
    # The replacement is written as typed, decomposed when typed so.
    assert rep('á', 'é', 'á') == 'é'
    # A group carries what it captured.
    assert rep(r'(p.)á', r'\1a', NFD, regex=True) == 'pʰa.PL'
    assert rep('a', 'o', 'pʰá') == 'pʰá'


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
