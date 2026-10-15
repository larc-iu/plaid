"""A concordance's tallies cover every occurrence, from grouped reads, once
more occurrences exist than it shows (survey item 10): the hit's own values,
the words it occurs in, and the word before and after."""

from test_read_scope import _ws

from plaid_agent.core.bidi import for_model
from plaid_agent.igt.toolkit import call_tool


def test_past_the_hits_shown_the_tallies_are_the_whole_corpus():
    out = for_model(call_tool(_ws(), 'concordance', {'pattern': 'di', 'limit': 1}))
    assert out.startswith('3 occurrences of "di" in morpheme (showing 1).'), out
    assert ('Across all 3 occurrences:\n  The hit\'s own Morph Gloss: ERG 3.\n  In words (form, slot): ali-di m2 3.\n'
            '  Word before: # 3.\n  Word after: gam 3.') in out
    assert 'Word patterns (hit in [brackets]), by frequency, among the 1 shown:' in out


def test_a_word_hit_tallies_its_word_fields_and_neighbours():
    out = for_model(call_tool(_ws(), 'concordance', {'pattern': 'gam', 'where': 'baseline', 'limit': 1}))
    assert ('Across all 3 occurrences:\n  The hit\'s own Gloss: (blank) 3.\n  Word before: ali-di 3.\n'
            '  Word after: akuna 3.') in out, out


def test_a_morpheme_field_hit_and_a_sentence_edge():
    out = for_model(call_tool(_ws(), 'concordance', {'pattern': 'Ali', 'where': 'Morph Gloss', 'limit': 2}))
    assert 'Across all 3 occurrences:' in out and 'Word before: # 3.' in out and 'Word after: gam 3.' in out, out


def test_when_every_occurrence_is_shown_the_tallies_are_of_them():
    out = for_model(call_tool(_ws(), 'concordance', {'pattern': 'di'}))
    assert 'Across all' not in out and 'The hit\'s own Morph Gloss: ERG 3.' in out, out
