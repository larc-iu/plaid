"""The surface check (AS, 2026-11-14): forms more than twice as long as the
word plus 3 cannot be that word's analysis, and every tool that stages an
analysis refuses them. In run4 of the job pilot a whole sentence's morphemes
went onto its first word with a note that allomorphy allows it. Forms that
differ from the word within that length are allomorphy and keep the note.
The word is read without the punctuation the project's ignored-token rule
trims off its edges (igtConfig.js ``trimIgnoredEdges``)."""

import copy

import pytest

from fixtures import FakeClient, document_raw, fake_ws

from plaid_agent.igt.tools import SURFACE_SLACK, surface_misfit, trim_ignored_edges
from plaid_agent.igt.toolkit import call_tool

PUNCT = {'type': 'unicodePunctuation', 'whitelist': []}


def ws(doc=None):
    return fake_ws(FakeClient(documents={'d1': doc or document_raw()}))


def _punctuated():
    """The fixture with akuna's token taking the full stop after it, as an
    import keeps it ("akuna.")."""
    raw = copy.deepcopy(document_raw())
    words = raw['text_layers'][0]['token_layers'][1]
    words['tokens'] = [t for t in words['tokens'] if t['id'] != 'w-p']
    next(t for t in words['tokens'] if t['id'] == 'w-3')['end'] = 17
    return raw


def test_the_rule_is_twice_the_length_plus_three():
    assert SURFACE_SLACK == 3
    # "gam" is 3 long: 9 characters of forms pass, 10 do not.
    assert surface_misfit('gam', ['gamga', 'mga'], PUNCT) is None
    assert surface_misfit('gam', ['gamga', 'mgamx'], PUNCT) is not None
    # Allomorphy shorter or longer within the bound is no misfit.
    assert surface_misfit('na', ['n'], PUNCT) is None
    assert surface_misfit('waayt', ['wag̲a', 'yt'], PUNCT) is None
    # The zero morph adds nothing, and edge punctuation is not the word.
    assert surface_misfit('a', ['∅', '∅', 'a', '∅'], PUNCT) is None
    assert surface_misfit('"Sim', ['ii', "'nii", 'win', 'hlen'], PUNCT) is not None


def test_trim_ignored_edges_is_the_apps():
    assert trim_ignored_edges('akuna.', PUNCT) == 'akuna'
    assert trim_ignored_edges('"Sim', PUNCT) == 'Sim'
    assert trim_ignored_edges("'a'", {'type': 'unicodePunctuation', 'whitelist': ["'"]}) == "'a'"
    assert trim_ignored_edges('...', PUNCT) == '...'
    assert trim_ignored_edges('akuna.', {'type': 'blacklist', 'blacklist': ['.']}) == 'akuna.'
    assert trim_ignored_edges('akuna.', None) == 'akuna.'


def test_set_analysis_refuses_a_sentence_on_one_word():
    w = ws()
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w2', 'morphemes': [
        {'form': 'Ali'}, {'form': 'di'}, {'form': 'gam'}, {'form': 'akuna'}]})
    assert out.startswith('Error') and w.ops == [], out
    assert ('s1.w2 "gam": forms "Alidigamakuna" are over twice as long as "gam" plus 3, too long for one word. '
            'Give the word\'s own morphemes: a sentence or a run of words takes analyze_sentence.') in out


def test_set_analysis_keeps_the_note_for_allomorphy_within_the_bound():
    w = ws()
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w3', 'morphemes': [
        {'form': 'akun'}, {'form': 'nan'}]})
    assert out.startswith('Planned 1 change') and 'differ from the surface "akuna"' in out


def test_the_note_reads_the_word_without_its_edge_punctuation():
    w = ws(_punctuated())
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w3', 'morphemes': [
        {'form': 'aku'}, {'form': 'na'}]})
    assert out.startswith('Planned 1 change') and 'differ' not in out, out


def test_set_analysis_for_form_refuses_forms_too_long_for_the_form():
    w = ws()
    out = call_tool(w, 'set_analysis_for_form', {'form': 'gam', 'morphemes': [
        {'form': 'gamga'}, {'form': 'makuna'}]})
    assert out.startswith('Error') and w.ops == [], out
    assert 'forms "gamgamakuna" are over twice as long as "gam" plus 3' in out
