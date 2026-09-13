"""One substitution, for both apps' find-and-replace.

The literal case is where it went wrong: a replacement a person typed as text
went into ``re.sub`` as a template, so "back\\slash" and "x\\1y" raised
instead of being written. The anchoring is the other half: ``whole`` anchors
the pattern rather than switching to ``fullmatch``, so a group captured in a
whole-value pattern can still be written back.
"""

import pytest

from plaid_agent.core.replace import replacer


def r(pattern, replacement, **kw):
    return replacer(pattern, replacement, kw.get('regex', False), kw.get('whole', False),
                    kw.get('case_sensitive', False))


def test_a_literal_replacement_is_text_and_not_a_template():
    assert r('x', 'back\\slash')('x') == 'back\\slash'
    assert r('x', 'a\\1b')('x') == 'a\\1b'
    assert r('x', '\\\\')('x') == '\\\\'
    # And in the whole-value case, which used to skip re.sub entirely.
    assert r('x', 'back\\slash', whole=True)('x') == 'back\\slash'


def test_a_backreference_expands_in_regex_mode_whole_value_included():
    assert r(r'(\w+)\.$', r'\1!', regex=True)('fish.') == 'fish!'
    assert r(r'(\w+)-(\w+)', r'\2-\1', regex=True, whole=True)('a-b') == 'b-a'


def test_whole_matches_the_value_and_nothing_less():
    assert r('cat', 'dog', whole=True)('cat') == 'dog'
    assert r('cat', 'dog', whole=True)('cats') == 'cats'
    assert r('cat', 'dog')('cats') == 'dogs'


def test_case_is_ignored_unless_asked_so_that_search_and_replace_agree():
    assert r('mar', 'mare')('Mar') == 'mare'
    assert r('mar', 'mare', case_sensitive=True)('Mar') == 'Mar'


def test_what_cannot_be_built_is_said_in_words():
    with pytest.raises(ValueError, match='Give a pattern'):
        r('', 'x')
    with pytest.raises(ValueError, match='not a valid regular expression'):
        r('(unclosed', 'x', regex=True)
    # A backreference to a group the pattern does not have fails on the value.
    apply = r('(a)', r'\2', regex=True)
    with pytest.raises(ValueError, match='not valid for that pattern'):
        apply('a')


def test_the_app_chooses_what_a_refusal_is():
    class Refused(Exception):
        pass

    with pytest.raises(Refused):
        replacer('', 'x', False, False, False, Refused)
