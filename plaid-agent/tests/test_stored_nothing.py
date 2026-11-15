"""The keep rule (``tools.in_place``) keeps only morphemes that hold something
of their own (FX, 2026-11-15). A word's lone morpheme stored with no form, no
type, no value and no link (the editor's default before 2026-09-11, and what
the e2e seed and old corpora still hold) is the derived morpheme stored: the
word has no analysis yet. An analysis given to it is written whole, form
included, as for a word with no morpheme stored. A morpheme with a stored
form, or a lone one holding a value or a link (plaid-igt's first gloss on an
unsegmented word stores no form), is kept as before."""

import pytest

from fixtures import FakeClient, MGLOSS, fake_ws, lexicon_raw
from test_restated_analysis import analyses, doc, project

from plaid_agent.igt.toolkit import call_tool

PELE = [{'form': 'gam', 'fields': {'Morph Gloss': 'fish'}}]


def _morph(raw):
    return raw['text_layers'][0]['token_layers'][2]


def ws_with(edit=None):
    raw = doc()
    if edit:
        edit(raw)
    return fake_ws(FakeClient(project=project(), documents={'d1': raw}, lexicon=lexicon_raw()))


def _token(raw, tid):
    return next(t for t in _morph(raw)['tokens'] if t['id'] == tid)


def _gloss(raw, tid, value, sid='sp-new'):
    next(sl for sl in _morph(raw)['span_layers'] if sl['id'] == MGLOSS)['spans'].append(
        {'id': sid, 'value': value, 'tokens': [tid]})


# --- a lone morpheme holding nothing: written whole ---------------------------------------------


def test_set_analysis_of_a_word_whose_morpheme_holds_nothing_writes_it_whole():
    """s1.w2 "gam" holds m-2, stored with no metadata, no value, no link."""
    w = ws_with()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w2', 'morphemes': PELE})
    (op,) = w.ops
    assert op['kind'] == 'set_analysis' and op['word_id'] == 'w-2'
    assert [m['form'] for m in op['morphemes']] == ['gam']


def test_analyze_sentence_writes_such_a_word_whole():
    w = ws_with()
    call_tool(w, 'analyze_sentence', {'document': 'd1', 'sentences': [{'ref': 's1.w2', 'words': ['gam fish']}]})
    assert [(o['word_id'], [m['form'] for m in o['morphemes']]) for o in analyses(w)] == [('w-2', ['gam'])]
    assert not any(o['kind'] == 'set_span' for o in w.ops)


def test_set_analysis_for_form_writes_such_a_word_whole():
    w = ws_with()
    call_tool(w, 'set_analysis_for_form', {'form': 'gam', 'morphemes': PELE})
    assert [(o['kind'], o.get('word_id')) for o in w.ops] == [('set_analysis', 'w-2')]


def test_a_word_whose_morpheme_holds_nothing_given_its_form_alone_is_written():
    """Nothing to restate: the form is written, as on a word with no morpheme."""
    w = ws_with()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w2', 'morphemes': [{'form': 'gam'}]})
    assert [o['kind'] for o in w.ops] == ['set_analysis']


def test_a_provenance_stamp_alone_is_nothing_of_its_own():
    """A stamp in the metadata is not a form, a type, a value or a link."""
    w = ws_with(lambda raw: _token(raw, 'm-2').update(metadata={'provSource': 'service:x'}))
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w2', 'morphemes': PELE})
    assert [o['kind'] for o in w.ops] == ['set_analysis']


# --- the neighbours: kept as before ------------------------------------------------------------


def test_a_lone_morpheme_with_its_stored_form_equal_to_the_word_is_kept():
    def edit(raw):
        _token(raw, 'm-2')['metadata'] = {'form': 'gam'}
        _gloss(raw, 'm-2', 'net')
    w = ws_with(edit)
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w2', 'morphemes': PELE})
    assert [(o['kind'], o['token_id'], o['value']) for o in w.ops] == [('set_span', 'm-2', 'fish')]
    w = ws_with(edit)
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w2', 'morphemes': [
        {'form': 'gam', 'fields': {'Morph Gloss': 'net'}}]})
    assert w.ops == [] and out.startswith('Nothing to change'), out


def test_a_lone_morpheme_with_a_stored_form_and_nothing_else_is_kept():
    w = ws_with(lambda raw: _token(raw, 'm-2').update(metadata={'form': 'gam'}))
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w2', 'morphemes': PELE})
    assert [(o['kind'], o['token_id'], o['value']) for o in w.ops] == [('set_span', 'm-2', 'fish')]


@pytest.mark.parametrize('held', ['gloss', 'link', 'type'])
def test_a_lone_morpheme_with_no_form_holding_a_value_a_link_or_a_type_is_kept(held):
    """plaid-igt's first gloss on an unsegmented word makes its morpheme with
    no form: a person's gloss there is kept, and restating it stages nothing."""
    def edit(raw):
        if held == 'gloss':
            _gloss(raw, 'm-2', 'net')
        elif held == 'link':
            _morph(raw)['vocabs'][0]['vocab_links'].append(
                {'id': 'l-9', 'vocab_item': {'id': 'vi-gam2', 'form': 'gam'}, 'tokens': ['m-2']})
        else:
            _token(raw, 'm-2')['metadata'] = {'morphType': 'root'}
    w = ws_with(edit)
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w2', 'morphemes': PELE})
    assert [(o['kind'], o['token_id']) for o in w.ops] == [('set_span', 'm-2')]
    if held == 'gloss':
        w = ws_with(edit)
        out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w2', 'morphemes': [
            {'form': 'gam', 'fields': {'Morph Gloss': 'net'}}]})
        assert w.ops == [] and out.startswith('Nothing to change'), out


def test_a_word_holding_only_a_word_gloss_is_written_whole():
    """s1.w3 "akuna" holds no morpheme. A word gloss on it is no morpheme."""
    def edit(raw):
        raw['text_layers'][0]['token_layers'][1]['span_layers'][0]['spans'].append(
            {'id': 'sp-g3', 'value': 'see', 'tokens': ['w-3']})
    w = ws_with(edit)
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w3', 'morphemes': [
        {'form': 'akuna', 'fields': {'Morph Gloss': 'see'}}]})
    assert [o['kind'] for o in w.ops] == ['set_analysis']


def test_a_zero_morpheme_is_a_stored_form_and_is_kept():
    """∅ is stored as a literal form: gam-∅ is kept, its gloss changed in place."""
    def edit(raw):
        _token(raw, 'm-2')['metadata'] = {'form': 'gam'}
        _morph(raw)['tokens'].append({'id': 'm-2z', 'begin': 7, 'end': 10, 'precedence': 2,
                                      'metadata': {'form': '∅', 'morphType': 'suffix'}})
        _gloss(raw, 'm-2', 'fish')
        _gloss(raw, 'm-2z', 'SG', 'sp-z')
    w = ws_with(edit)
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w2', 'morphemes': [
        {'form': 'gam', 'fields': {'Morph Gloss': 'fish'}}, {'form': '∅', 'fields': {'Morph Gloss': 'SG'}}]})
    assert w.ops == [] and out.startswith('Nothing to change'), out
    w = ws_with(edit)
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w2', 'morphemes': [
        {'form': 'gam', 'fields': {'Morph Gloss': 'fish'}}, {'form': '∅', 'fields': {'Morph Gloss': 'PL'}}]})
    assert [(o['kind'], o['token_id'], o['value']) for o in w.ops] == [('set_span', 'm-2z', 'PL')]


# --- a morpheme holding nothing inside a person's chain (REV-DF-D-8) ----------------------------


def _chain(raw):
    """gam as a person's "ga" 'fish' linked to an entry, then a morpheme stored with nothing of its own."""
    m2 = _token(raw, 'm-2')
    m2['metadata'] = {'form': 'ga'}
    _morph(raw)['tokens'].append({'id': 'm-2z', 'begin': m2['begin'], 'end': m2['end'], 'precedence': 2,
                                  'metadata': {}})
    _gloss(raw, 'm-2', 'fish')
    _morph(raw)['vocabs'][0]['vocab_links'].append(
        {'id': 'l-9', 'vocab_item': {'id': 'vi-gam2', 'form': 'ga'}, 'tokens': ['m-2']})


@pytest.mark.parametrize('tool', ['set_analysis', 'analyze_sentence', 'set_analysis_for_form'])
def test_a_chain_with_a_morpheme_holding_nothing_is_kept_and_the_form_given_written_on_it(tool):
    """REV-DF-D-8: only a word whose ONE morpheme holds nothing has no
    analysis to keep. A person's chain restated with a morpheme that holds
    nothing is kept: its "ga", gloss and link stay as they are, and the form
    given is written on the empty morpheme, with the value given."""
    w = ws_with(_chain)
    given = [{'form': 'ga', 'fields': {'Morph Gloss': 'fish'}}, {'form': 'm', 'fields': {'Morph Gloss': 'SG'}}]
    if tool == 'set_analysis':
        call_tool(w, tool, {'document': 'd1', 'ref': 's1.w2', 'morphemes': given})
    elif tool == 'analyze_sentence':
        call_tool(w, tool, {'document': 'd1', 'sentences': [{'ref': 's1.w2', 'words': ['ga-m fish-SG']}]})
    else:
        call_tool(w, tool, {'form': 'gam', 'morphemes': given})
    assert sorted((o['kind'], o.get('morpheme_id') or o.get('token_id'), o.get('form') or o.get('value'))
                  for o in w.ops) == [('set_morpheme_form', 'm-2z', 'm'), ('set_span', 'm-2z', 'SG')], w.ops
