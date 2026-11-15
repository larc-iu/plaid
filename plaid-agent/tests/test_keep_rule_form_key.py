"""The keep rule compares forms by the app's own key (FX, REV-DAY-S-1). A
restatement whose forms differ from the stored ones only as ``fit.form_key``
ignores (letter case, NFC) keeps the word's morphemes and their STORED forms:
"ali-di Ali-ERG" given for a person's "Ali-di" changes nothing, and a gloss
it changes is the only thing staged. A form that differs by more replaces the
chain, as before. (``fit.form_key`` is the lexicon's key, collationKey: lower
case after NFC. igt/job.py has another function of that name that casefolds,
REV-DAY-SURFACE P-1, left to another lane.)"""

import pytest

from test_restated_analysis import ALIDI, analyses, only_erg, ws

from plaid_agent.igt.toolkit import call_tool


@pytest.mark.parametrize('given', [
    [{'form': 'ali', 'fields': {'Morph Gloss': 'Ali'}}, {'form': 'di', 'fields': {'Morph Gloss': 'ERG'}}],
    [{'form': 'ALI', 'fields': {'Morph Gloss': 'Ali'}}, {'form': 'DI', 'fields': {'Morph Gloss': 'ERG'}}],
], ids=['lower', 'upper'])
def test_a_restatement_differing_only_in_case_stages_nothing(given):
    w = ws()
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': given})
    assert w.ops == [] and out.startswith('Nothing to change'), out


def test_a_gloss_changed_beside_a_case_only_form_is_the_one_value_staged():
    w = ws()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [
        {'form': 'ali', 'fields': {'Morph Gloss': 'Ali'}}, {'form': 'di', 'fields': {'Morph Gloss': 'GEN'}}]})
    assert [(o['kind'], o['token_id'], o['value']) for o in w.ops] == [('set_span', 'm-1b', 'GEN')]
    # The label names the stored form, never the one given.
    assert 's1.w1.m2 "di"' in w.ops[0]['label']


def test_analyze_sentence_and_set_analysis_for_form_read_it_the_same_way():
    """Ali is unlinked and no entry fits it in this lexicon (as in
    test_restated_analysis), so nothing at all is staged."""
    w = ws(only_erg())
    out = call_tool(w, 'analyze_sentence', {'document': 'd1', 'sentences': [
        {'ref': 's1.w1', 'words': ['ali-di Ali-ERG']}]})
    assert w.ops == [] and 'Nothing to change in w1' in out, out
    w = ws()
    out = call_tool(w, 'set_analysis_for_form', {'form': 'Ali-di', 'morphemes': [
        {'form': 'ali', 'fields': {'Morph Gloss': 'Ali'}}, {'form': 'di', 'fields': {'Morph Gloss': 'ERG'}}]})
    assert w.ops == [] and out.startswith('Nothing to change'), out


@pytest.mark.parametrize('given', [
    [{'form': 'Ali'}, {'form': 'du'}],
    [{'form': 'Alí'}, {'form': 'di'}],
], ids=['letter', 'accent'])
def test_a_form_that_differs_by_more_than_the_key_replaces_the_chain(given):
    w = ws()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': given})
    assert [o['kind'] for o in w.ops] == ['set_analysis']
    assert len(analyses(w)) == 1


def test_the_stored_restatement_still_stages_nothing():
    w = ws()
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': ALIDI})
    assert w.ops == [] and out.startswith('Nothing to change'), out
