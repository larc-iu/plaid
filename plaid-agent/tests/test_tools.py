import re
import pytest
from fixtures import scan_ws, FakeClient

from plaid_agent.igt.toolkit import call_tool, TOOLS, _IMPL


def ws():
    c = FakeClient()
    return scan_ws(c)


def test_every_declared_tool_has_an_implementation():
    assert {t['function']['name'] for t in TOOLS} == set(_IMPL)


def test_documents_resolve_by_id_name_or_prefix():
    w = ws()
    assert w.resolve_document_id('d1') == 'd1'
    assert w.resolve_document_id('text 1') == 'd1'
    assert w.resolve_document_id('Tex') == 'd1'
    assert 'No document "zzz"' in call_tool(w, 'read_document', {'document': 'zzz'})


def test_search_baseline_morpheme_field_and_lexicon():
    w = ws()
    out = call_tool(w, 'search', {'pattern': 'gam'})
    assert out.startswith('2 hits:')
    assert 's1.w2 gam || Ali-di gam akuna.' in out and 's2.w1 Gam-ar | seg=Gam=ar' in out
    assert '3 hits' in call_tool(w, 'search', {'pattern': 'a', 'where': 'morpheme'})  # Ali, gam, Gam, ar -> words w1,w2,w4
    out = call_tool(w, 'search', {'pattern': 'ERG', 'where': 'Morph Gloss'})
    assert '1 hits:' in out and 's1.w1' in out
    out = call_tool(w, 'search', {'pattern': 'fish', 'where': 'Translation'})
    assert 's1 Translation=Ali saw a fish.' in out
    out = call_tool(w, 'search', {'pattern': 'gam', 'where': 'lexicon'})
    assert 'gam | gloss=fish (Lexicon)' in out and 'gam | gloss=net (Lexicon)' in out
    assert call_tool(w, 'search', {'pattern': 'nothing-here'}) == 'No hits.'
    assert 'No field named "Nope"' in call_tool(w, 'search', {'pattern': 'x', 'where': 'Nope'})
    assert '^gam' and 's2.w1' in call_tool(w, 'search', {'pattern': '^gam-', 'regex': True})


def test_frequency_list_reports_field_values_with_empties():
    w = ws()
    out = call_tool(w, 'frequency_list', {'what': 'Morph Gloss'})
    assert out.startswith('2 Morph Gloss values, 2 tokens, 3 empty.')
    assert '  1\t1\tERG' in out
    assert call_tool(w, 'field_values', {'field': 'Morph Gloss'}) == 'Error: there is no tool named field_values.'


def test_read_lexicon():
    out = call_tool(ws(), 'read_lexicon', {'pattern': 'gam'})
    assert 'Lexicon "Lexicon": 4 headwords, 0 senses, 2 matching' in out


def test_set_field_plans_create_update_clear_and_respects_scope():
    w = ws()
    out = call_tool(w, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1', 's1.w2'], 'field': 'Gloss', 'value': 'X'})
    assert out.startswith('Planned 2 changes')
    assert w.ops[0] == {'kind': 'set_span', 'layer_id': 'sl-gloss', 'token_id': 'w-1', 'span_id': 'sp-g1', 'value': 'X',
                        'label': 'Text 1 s1.w1 "Ali-di": Gloss "Ali" → "X"', 'change_at': 23}
    assert w.ops[1]['span_id'] is None and w.ops[1]['token_id'] == 'w-2'
    # unchanged value -> nothing planned
    assert call_tool(w, 'set_field', {'document': 'd1', 'refs': 's1.w1', 'field': 'Gloss', 'value': 'Ali'}).startswith('Planned 0')
    # clearing: replaces the earlier planned op on that span (last wins)
    call_tool(w, 'set_field', {'document': 'd1', 'refs': 's1.w1', 'field': 'Gloss', 'value': ''})
    op = next(o for o in w.ops if o['token_id'] == 'w-1')
    assert op['value'] == '' and '(cleared)' in op['label'] and len(w.ops) == 2
    # scope mismatch
    assert 'is not a morpheme' in call_tool(w, 'set_field', {'document': 'd1', 'refs': 's1.w1', 'field': 'Morph Gloss', 'value': 'x'})
    assert 'is not a sentence' in call_tool(w, 'set_field', {'document': 'd1', 'refs': 's1.w1', 'field': 'Translation', 'value': 'x'})
    # sentence + morpheme scopes work
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s2'], 'field': 'Translation', 'value': 'Nets.'})
    assert w.ops[-1]['token_id'] == 's-2'
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1.m2'], 'field': 'Morph Gloss', 'value': 'OBL'})
    assert w.ops[-1]['token_id'] == 'm-1b' and w.ops[-1]['span_id'] == 'sp-m1b'


def test_set_analysis_plans_a_resolved_chain():
    w = ws()
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's2.w1', 'morphemes': [
        {'form': 'gam', 'type': 'stem', 'fields': {'Morph Gloss': 'fish'}},
        {'form': 'ar', 'type': 'suffix', 'fields': {'morph gloss': 'PL'}}]})
    assert out.startswith('Planned 1 change')
    op = w.ops[0]
    assert op['kind'] == 'set_analysis' and op['word_id'] == 'w-4' and (op['begin'], op['end']) == (18, 24)
    assert op['existing'] == [{'id': 'm-4a', 'span_ids': []}, {'id': 'm-4b', 'span_ids': []}]
    assert op['morphemes'] == [
        {'form': 'gam', 'morph_type': 'stem', 'fields': [{'layer_id': 'sl-mgloss', 'value': 'fish'}]},
        {'form': 'ar', 'morph_type': 'suffix', 'fields': [{'layer_id': 'sl-mgloss', 'value': 'PL'}]}]
    assert op['label'] == 'Text 1 s2.w1 "Gam-ar": Gam=ar → gam-ar, Morph Gloss fish-PL'
    assert 'differ from the surface' in out  # gam+ar vs Gam-ar (hyphen, case)
    assert 'is a Word field' in call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w2',
                                                               'morphemes': [{'form': 'gam', 'fields': {'Gloss': 'x'}}]})


def test_orthography_respell_links_entries():
    w = ws()
    call_tool(w, 'set_orthography', {'document': 'd1', 'refs': ['s1.w1', 's1.w2'], 'orthography': 'ipa', 'value': 'alidi'})
    assert len(w.ops) == 1 and w.ops[0] == {'kind': 'set_orthography', 'word_id': 'w-2', 'key': 'orthog:IPA',
                                            'value': 'alidi', 'label': 'Text 1 s1.w2 "gam": IPA = "alidi"',
                                            'change_at': 20}
    assert 'No orthography named "Cyr"' in call_tool(w, 'set_orthography', {'document': 'd1', 'refs': 's1.w1', 'orthography': 'Cyr', 'value': 'x'})
    call_tool(w, 'respell', {'document': 'd1', 'ref': 's1.w3', 'new_text': 'akun'})
    assert w.ops[-1] == {'kind': 'respell', 'text_id': 'text1', 'begin': 11, 'end': 16, 'value': 'akun', 'doc': 'd1',
                         'label': 'Text 1 s1.w3: respell "akuna" → "akun"', 'change_at': 14}
    # ambiguous entry -> candidates with ids
    out = call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w2'], 'entry_form': 'gam'})
    # Each candidate is offered under the number the app shows beside it, so
    # the model can answer with "gam#2" rather than only with an id.
    assert 'Several entries match "gam"' in out
    assert 'id=vi-gam form=gam#1 gam | gloss=fish' in out
    assert 'id=vi-gam2 form=gam#2 gam | gloss=net' in out
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w2'], 'entry_id': 'vi-gam'})
    assert w.ops[-1] == {'kind': 'link', 'token_id': 'w-2', 'item_id': 'vi-gam', 'new_entry_key': None,
                         'existing_link_id': None, 'entry_form': 'gam', 'label': 'Text 1 s1.w2 "gam": link "gam"'}
    # relinking replaces the existing link; linking to the same entry is a no-op
    assert call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w1'], 'entry_form': 'Ali'}).startswith('Planned 0')
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w1'], 'entry_form': '-di'})
    assert w.ops[-1]['existing_link_id'] == 'l-1' and 'link "Ali" → "-di"' in w.ops[-1]['label']
    call_tool(w, 'unlink_entry', {'document': 'd1', 'refs': ['s1.w1.m2', 's1.w2']})
    assert w.ops[-1] == {'kind': 'unlink', 'link_id': 'l-2', 'token_id_hint': 'm-1b', 'label': 'Text 1 s1.w1.m2 "di": unlink "-di"'}
    # new entry, then link to it in the same plan
    out = call_tool(w, 'create_entry', {'form': 'akun', 'fields': {'gloss': 'see'}, 'type': 'stem'})
    key = out.split('entry_id: ')[1].split()[0]
    assert w.ops[-1]['kind'] == 'create_entry' and w.ops[-1]['metadata'] == {'gloss': 'see', 'morphType': 'stem'}
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w3'], 'entry_form': 'akun'})
    assert w.ops[-1]['new_entry_key'] == key and w.ops[-1]['item_id'] is None
    call_tool(w, 'set_entry_field', {'entry_form': 'akun', 'field': 'pos', 'value': 'V'})
    assert w.ops[-2]['metadata'] == {'gloss': 'see', 'morphType': 'stem', 'pos': 'V'}  # folded into the pending create
    call_tool(w, 'set_entry_field', {'entry_id': 'vi-ali', 'field': 'pos', 'value': 'PN'})
    assert w.ops[-1] == {'kind': 'set_entry_field', 'item_id': 'vi-ali', 'field': 'pos', 'value': 'PN',
                         'label': 'entry "Ali": pos "N" → "PN"'}
    payload = w.plan_payload()
    assert payload['summary'].startswith('1 orthography value, 1 respelling')
    assert len(payload['labels']) == len(payload['ops']) == len(w.ops)
    assert call_tool(w, 'discard_plan', {}) == f'Discarded {len(payload["ops"])} planned changes.'
    assert w.plan_payload() is None


def test_tool_errors_come_back_as_text():
    w = ws()
    assert call_tool(w, 'nope', {}) == 'Error: there is no tool named nope.'
    assert call_tool(w, 'set_field', {'document': 'd1'}).startswith('Error:')
    # The same sentence both apps use, wherever a pattern is compiled.
    out = call_tool(w, 'search', {'pattern': '(', 'regex': True})
    assert out.startswith('Error: That pattern cannot be used:')


def test_an_argument_a_tool_does_not_take_names_the_tool_and_its_parameters():
    """Binding answered with Python's own words and the INTERNAL function's
    name: "t_create_entry() got an unexpected keyword argument 'gloss'"."""
    out = call_tool(ws(), 'create_entry', {'form': 'ndiwo', 'gloss': 'relish'})
    assert out.startswith('Error: create_entry cannot be called with those arguments. It takes: ')
    assert 'form' in out and 'fields' in out
    for leak in ('t_create_entry', 'keyword argument', 'positional'):
        assert leak not in out, out


def test_an_unexpected_failure_is_a_sentence_and_not_a_type_name():
    """A tool that breaks answered with the exception's class name, which is
    nothing the model can act on and invites it to retry the same call."""
    from plaid_agent.igt import toolkit

    def boom(ws, **kw):
        raise RuntimeError('a dict key')

    w = ws()
    toolkit._IMPL['boom'] = boom
    try:
        out = call_tool(w, 'boom', {})
    finally:
        del toolkit._IMPL['boom']
    assert out.startswith('Error: boom failed, which is a fault in the tool')
    assert 'RuntimeError' not in out and 'a dict key' not in out


def test_search_without_pattern_points_to_worklist():
    assert 'use worklist' in call_tool(ws(), 'search', {})
    assert call_tool(ws(), 'search', {'where': 'Gloss', 'missing': True}).startswith('Error:')


def test_refs_accept_document_prefixes_and_reject_junk():
    w = ws()
    out = call_tool(w, 'set_field', {'document': 'd1', 'refs': ['"Text 1" s1.w1', 's1.w2, s1.w3'], 'field': 'Gloss', 'value': 'X'})
    assert 'Planned 3 changes' in out
    assert 'Bad reference "w1"' in call_tool(w, 'set_field', {'document': 'd1', 'refs': 'w1', 'field': 'Gloss', 'value': 'X'})


def test_morph_types_and_lexicon_fields_are_validated():
    w = ws()
    assert 'Unknown morph type "sufix"' in call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w2', 'morphemes': [{'form': 'gam', 'type': 'sufix'}]})
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w2', 'morphemes': [{'form': 'gam', 'type': 'Bound Stem'}]})
    assert w.ops[-1]['morphemes'][0]['morph_type'] == 'bound stem'
    # a lexicon with a configured field schema rejects unknown entry fields
    c = FakeClient()
    c.project['vocabs'][0]['config'] = {'igt': {'fields': {'gloss': {'inline': True}, 'pos': {'inline': False}}}}
    w2 = scan_ws(c)
    assert 'has no entry field "definition"' in call_tool(w2, 'create_entry', {'form': 'x', 'fields': {'definition': 'y'}})
    call_tool(w2, 'create_entry', {'form': 'x', 'fields': {'Gloss': 'y'}})
    assert w2.ops[-1]['metadata'] == {'gloss': 'y'}
    # morphType and gloss ride along on every vocabulary, declared or not.
    assert 'entry fields: morphType, gloss, pos' in call_tool(w2, 'project_overview', {})


def test_homograph_numbers_pick_an_entry():
    c = FakeClient()
    c._lexicon['items'][2]['metadata']['homograph'] = 1
    c._lexicon['items'][3]['metadata']['homograph'] = 2
    w = scan_ws(c)
    out = call_tool(w, 'link_entry', {'document': 'd1', 'refs': 's1.w2', 'entry_form': 'gam'})
    assert 'form=gam#1' in out and 'form=gam#2' in out
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': 's1.w2', 'entry_form': 'gam#2'})
    assert w.ops[-1]['item_id'] == 'vi-gam2'


def _machine_doc():
    """The fixture document with machine-made pieces: w1's Gloss span and link, m1b's
    segmentation and gloss (unconfirmed), m1a's gloss (already verified), and a
    machine link on w4's second morpheme."""
    from fixtures import document_raw
    raw = document_raw()
    layers = raw['text_layers'][0]['token_layers']
    m = {'prov': 'inferred', 'provSource': 'service:x'}
    layers[1]['span_layers'][0]['spans'][0]['metadata'] = dict(m)                      # sp-g1 (Gloss on w-1)
    layers[1]['vocabs'][0]['vocab_links'][0]['metadata'] = dict(m)                     # l-1 (w-1 link)
    layers[2]['tokens'][1]['metadata'] = {**layers[2]['tokens'][1]['metadata'], **m}   # m-1b segmentation
    layers[2]['tokens'][4]['metadata'] = {**layers[2]['tokens'][4]['metadata'], **m}   # m-4b segmentation
    layers[2]['span_layers'][0]['spans'][0]['metadata'] = {**m, 'provConfirmed': True}  # sp-m1a verified
    layers[2]['span_layers'][0]['spans'][1]['metadata'] = dict(m)                      # sp-m1b
    layers[2]['vocabs'][0]['vocab_links'][0]['metadata'] = dict(m)                     # l-2 (m-1b link)
    return raw


def test_confirm_collects_unconfirmed_machine_pieces():
    c = FakeClient(documents={'d1': _machine_doc()})
    w = scan_ws(c)
    out = call_tool(w, 'confirm', {'document': 'd1', 'refs': ['s1.w1']})
    assert 'Planned 1 change' in out and '5 annotations will be marked verified' in out
    op = w.ops[0]
    assert op['kind'] == 'confirm'
    assert sorted(op['span_ids']) == ['sp-g1', 'sp-m1b'] and op['token_ids'] == ['m-1b'] and sorted(op['link_ids']) == ['l-1', 'l-2']
    assert op['label'] == 'Text 1 s1.w1 "Ali-di": confirm 2 values, 2 links, 1 segmentation'
    # Field-restricted: only that field's spans, no links or segmentations.
    w2 = scan_ws(c)
    call_tool(w2, 'confirm', {'document': 'd1', 'refs': ['s1'], 'field': 'Morph Gloss'})
    assert w2.ops[0]['span_ids'] == ['sp-m1b'] and not w2.ops[0]['token_ids'] and not w2.ops[0]['link_ids']
    # Whole document: one op.
    w3 = scan_ws(c)
    out = call_tool(w3, 'confirm', {'document': 'd1'})
    assert len(w3.ops) == 1 and w3.ops[0]['label'].startswith('Text 1: confirm 2 values, 2 links, 2 segmentations')
    assert '6 annotations' in out
    # Nothing unverified there.
    assert call_tool(w3, 'confirm', {'document': 'd1', 'refs': ['s1.w3']}).startswith('Nothing to confirm')


def test_confirm_leaves_a_machine_value_off_a_closed_tagset_and_names_it():
    """A machine value off a closed tagset is exempt from it only while it is
    unreviewed, so confirming it is refused, and with it the whole batch at
    approval (REV-UD-UMR F4, the igt side). It is left unconfirmed and named,
    and the rest is confirmed."""
    from fixtures import MGLOSS
    c = FakeClient(documents={'d1': _machine_doc()})
    w = scan_ws(c)
    w.project.field_by_layer(MGLOSS).value_sets = [{'type': 'value-set', 'values': ['Ali', 'PST'],
                                                    'delimiters': '.'}]
    out = call_tool(w, 'confirm', {'document': 'd1', 'refs': ['s1.w1']})
    assert 'Not in the tagset, left unconfirmed: ERG (Morph Gloss, di).' in out
    op = w.ops[0]
    assert op['span_ids'] == ['sp-g1'] and 'left' not in op
    assert op['label'].endswith(', 1 not in the tagset left unconfirmed')
    w2 = scan_ws(c)
    w2.project.field_by_layer(MGLOSS).value_sets = w.project.field_by_layer(MGLOSS).value_sets
    out = call_tool(w2, 'confirm', {'document': 'd1', 'refs': ['s1'], 'field': 'Morph Gloss'})
    assert out == 'Not in the tagset, left unconfirmed: ERG (Morph Gloss, di). Nothing else awaits review there.'
    assert w2.ops == []
    # Listed, it is confirmed as before.
    w3 = scan_ws(c)
    w3.project.field_by_layer(MGLOSS).value_sets = [{'type': 'value-set', 'values': ['Ali', 'ERG']}]
    call_tool(w3, 'confirm', {'document': 'd1', 'refs': ['s1.w1']})
    assert sorted(w3.ops[0]['span_ids']) == ['sp-g1', 'sp-m1b']


def test_discard_analysis_mirrors_the_editor():
    c = FakeClient(documents={'d1': _machine_doc()})
    w = scan_ws(c)
    out = call_tool(w, 'discard_analysis', {'document': 'd1', 'refs': ['s1.w1', 's1.w3', 's2']})
    assert 'Planned 2 changes' in out
    a, b = w.ops
    # w1: machine gloss + link on the word go; m-1b (machine, not first) is deleted outright; m-1a (human) stays.
    assert a['word_id'] == 'w-1' and a['span_ids'] == ['sp-g1'] and a['link_ids'] == ['l-1']
    assert a['morpheme_ids'] == ['m-1b'] and a['reset_first_id'] is None and a['renumber'] == []
    assert a['label'] == 'Text 1 s1.w1 "Ali-di": discard unverified 1 value, 1 link, the segmentation'
    # w4 (via s2): only the machine second morpheme goes.
    assert b['word_id'] == 'w-4' and b['morpheme_ids'] == ['m-4b'] and b['span_ids'] == [] and b['link_ids'] == []
    assert 'not single morphemes' in call_tool(w, 'discard_analysis', {'document': 'd1', 'refs': ['s1.w1.m1']})
    # A later set_analysis on the same word supersedes the discard (same target).
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1', 'morphemes': [{'form': 'Alidi'}]})
    assert [o['kind'] for o in w.ops] == ['set_analysis', 'discard_analysis'] and w.ops[0]['word_id'] == 'w-1'


def test_single_respell_carries_a_lone_matching_morpheme_form():
    from fixtures import document_raw
    raw = document_raw()
    raw['text_layers'][0]['token_layers'][2]['tokens'][2]['metadata'] = {'form': 'gam'}  # m-2 stores its form
    c = FakeClient(documents={'d1': raw})
    w = scan_ws(c)
    out = call_tool(w, 'respell', {'document': 'd1', 'ref': 's1.w2', 'new_text': 'gham'})
    assert 'Planned 2 changes' in out
    assert [o['kind'] for o in w.ops] == ['respell', 'set_morpheme_form'] and w.ops[1] == {
        'kind': 'set_morpheme_form', 'morpheme_id': 'm-2', 'form': 'gham',
        'label': 'Text 1 s1.w2.m1 (in "gam"): morpheme form "gam" → "gham"', 'change_at': 28}
    # A chain cannot be re-derived from a whole-word respelling: kept, and said so.
    out = call_tool(w, 'respell', {'document': 'd1', 'ref': 's1.w1', 'new_text': 'Alidi'})
    assert 'Planned 1 change' in out and 'Morpheme forms Ali, di are kept' in out
    w2 = scan_ws(c)
    call_tool(w2, 'respell', {'document': 'd1', 'ref': 's1.w2', 'new_text': 'gham', 'morpheme_forms': False})
    assert [o['kind'] for o in w2.ops] == ['respell']


def test_morpheme_form_ops_yield_to_a_rewrite_of_the_same_analysis():
    from plaid_agent.igt.plan import normalize_ops, execute_plan
    ops = [{'kind': 'set_morpheme_form', 'morpheme_id': 'm-1a', 'form': 'x', 'label': 'f1'},
           {'kind': 'set_morpheme_form', 'morpheme_id': 'm-9', 'form': 'y', 'label': 'f2'},
           {'kind': 'set_analysis', 'word_id': 'w-1', 'text_id': 't', 'begin': 0, 'end': 6, 'morpheme_layer_id': 'ml',
            'existing': [{'id': 'm-1a', 'span_ids': []}], 'morphemes': [{'form': 'Alidi', 'fields': []}], 'label': ''}]
    out, notes = normalize_ops(ops)
    assert [o['kind'] for o in out] == ['set_morpheme_form', 'set_analysis'] and out[0]['morpheme_id'] == 'm-9'
    assert notes == ['dropped: f1 (that analysis is rewritten in this plan)']
    c = FakeClient()
    counts = execute_plan(c, ops, source='s', label='l')
    form = [{'op': 'set', 'path': ['form'], 'value': 'y'}]
    assert counts['morpheme forms'] == 1 and ('m-9', form) in c.patches('tokens')


def test_entry_gloss_singles_out_a_homograph():
    w = ws()
    # two entries "gam" (fish, net): the gloss picks one everywhere an entry is named
    assert 'Several entries match "gam"' in call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w2'], 'entry_form': 'gam'})
    assert 'entry_gloss' in call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w2'], 'entry_form': 'gam'})
    out = call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w2'], 'entry_form': 'gam', 'entry_gloss': 'NET'})
    assert 'Planned 1 change' in out and w.ops[-1]['item_id'] == 'vi-gam2'
    out = call_tool(w, 'lexicon_entry', {'entry_form': 'gam', 'entry_gloss': 'fish'})
    assert 'gloss: fish' in out and 'net' not in out
    call_tool(w, 'rename_entry', {'entry_form': 'gam', 'entry_gloss': 'net', 'new_form': 'gham'})
    assert w.ops[-1] == {'kind': 'rename_entry', 'item_id': 'vi-gam2', 'form': 'gham', 'label': 'Rename entry "gam#2" (net) → "gham"'}
    merge = {'keep_form': 'gam', 'keep_gloss': 'fish', 'remove_form': 'gam', 'remove_gloss': 'net'}
    # The link and the rename planned above both write to the entry the merge
    # removes, so the merge refuses until they are dropped.
    assert 'writes to something this plan deletes' in call_tool(w, 'merge_entries', merge)
    call_tool(w, 'drop_planned', {'indexes': [1, 2]})
    call_tool(w, 'merge_entries', merge)
    assert w.ops[-1]['kind'] == 'merge_entries' and (w.ops[-1]['keep_id'], w.ops[-1]['remove_id']) == ('vi-gam', 'vi-gam2')
    assert 'No lexicon entry "gam" with a field valued "boat"' in call_tool(w, 'delete_entry', {'entry_form': 'gam', 'entry_gloss': 'boat'})


def test_reads_mark_unverified_machine_material():
    from plaid_agent.igt.project import render_document
    c = FakeClient(documents={'d1': _machine_doc()})
    w = scan_ws(c)
    out = render_document(w.doc('d1'), w.project)
    assert 'w1 Ali-di | seg=Ali-di~ types=?,suffix | Morph Gloss=Ali-ERG~ | Gloss=Ali~ | IPA=alidi | link=Ali~ | mlinks=m2:-di~' in out
    assert 'w1 Gam-ar | seg=Gam=ar~' in out  # m-4b is machine-made
    assert 'Translation: Ali saw a fish.\n' in out  # human: unmarked
    assert 'A trailing ~ marks' in out
    plain = render_document(ws().doc('d1'), ws().project)
    assert '~' not in plain.replace('A trailing ~ marks', '')


def test_the_plan_refuses_to_grow_past_what_a_record_holds(monkeypatch):
    """The cap UD has had since the record budget was measured. Without it a
    corpus-wide edit staged thousands of ops, the record could not hold them,
    and the turn came back with no plan after the model had announced one."""
    from plaid_agent.core import workspace
    monkeypatch.setattr(workspace, 'PLAN_MAX_OPS', 3)
    w = ws()
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1', 's1.w2'], 'field': 'Gloss', 'value': 'X'})
    out = call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w3', 's2.w1'], 'field': 'Gloss', 'value': 'Y'})
    # A sentence, not a traceback, and it says what to do about it.
    assert 'more than the 3 one plan may hold' in out
    assert 'approve what is planned' in out
    assert len(w.ops) == 2  # nothing half staged
    # One more still fits, and lands.
    assert call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w3'], 'field': 'Gloss',
                                      'value': 'Y'}).startswith('Planned 1')
    assert len(w.ops) == 3
    # The 4th is refused one at a time as well as in a batch.
    assert 'more than the 3 one plan may hold' in call_tool(
        w, 'set_field', {'document': 'd1', 'refs': ['s2.w1'], 'field': 'Gloss', 'value': 'Y'})
    assert len(w.ops) == 3


def test_plan_payload_records_the_documents_it_touches_with_versions():
    w = ws()
    assert w.plan_payload() is None
    call_tool(w, 'set_entry_field', {'entry_form': 'Ali', 'field': 'pos', 'value': 'PN'})
    assert w.plan_payload()['documents'] == []  # a lexicon-only plan touches no document
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'fish'})
    [doc] = w.plan_payload()['documents']
    assert {k: doc[k] for k in ('id', 'name', 'version')} == {'id': 'd1', 'name': 'Text 1', 'version': 7}
    # A value on one word depends on that word's sentence only.
    assert [s['id'] for s in doc['sentences']] == ['s-1']
    w2 = ws()
    call_tool(w2, 'respell', {'document': 'd1', 'ref': 's1.w2', 'new_text': 'gham'})  # text id only
    assert [d['id'] for d in w2.plan_payload()['documents']] == ['d1']
    # A respelling names the text, so it is pinned to the whole document.
    assert 'sentences' not in w2.plan_payload()['documents'][0]
    w3 = ws()
    call_tool(w3, 'rename_document', {'document': 'd1', 'new_name': 'T'})
    assert [d['id'] for d in w3.plan_payload()['documents']] == ['d1']


def test_stale_documents_refuse_a_plan_made_against_older_data():
    from plaid_agent.igt.service import stale_documents
    c = FakeClient()
    assert stale_documents(c, [{'id': 'd1', 'name': 'Text 1', 'version': 7}]) == []
    assert stale_documents(c, [{'id': 'd1', 'name': 'Text 1', 'version': 6}]) == ['document "Text 1" has changed since the plan was made']
    # A record that cannot be checked refuses the plan rather than being waved
    # through: the one case this exists to catch is the one where the check
    # could not run.
    out = stale_documents(c, [{'id': 'd1', 'version': None}, 'junk'])
    assert len(out) == 2
    assert 'recorded without a version' in out[0] and 'cannot identify' in out[1]
    out = stale_documents(c, [{'id': 'nope', 'name': 'Gone', 'version': 1}])
    assert len(out) == 1 and 'could not be read' in out[0]


def test_drop_planned_keeps_the_rest_and_takes_links_to_dropped_entries_along():
    w = ws()
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2', 's1.w3'], 'field': 'Gloss', 'value': 'x'})
    out = call_tool(w, 'create_entry', {'form': 'akun', 'fields': {'gloss': 'see'}})
    key = out.split('entry_id: ')[1].split()[0]
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w3'], 'entry_id': key})
    call_tool(w, 'set_orthography', {'document': 'd1', 'refs': ['s1.w3'], 'orthography': 'IPA', 'value': 'akuna'})
    assert [o['kind'] for o in w.ops] == ['set_span', 'set_span', 'create_entry', 'link', 'set_orthography']
    assert 'No planned change number 9' in call_tool(w, 'drop_planned', {'indexes': [9]})
    out = call_tool(w, 'drop_planned', {'indexes': [1, 3]})
    assert out.startswith('Dropped 2 planned changes. Links to the dropped new entries were dropped with them.')
    assert [o['kind'] for o in w.ops] == ['set_span', 'set_orthography'] and w.ops[0]['token_id'] == 'w-3'
    assert w.new_entries == {} and '2 planned changes' in out
    assert 'Dropped 1' in call_tool(w, 'drop_planned', {'indexes': 2}) and len(w.ops) == 1


def test_citations_resolve_to_interlinear_examples():
    from plaid_agent.igt.citations import resolve_citations
    w = ws()
    text = ('Wh-words stay in situ, e.g. <cite doc="Text 1" ref="s1"/> and <cite ref="s2.w1" doc=\'Text 1\'></cite>; '
            'the ergative suffix <cite doc="Text 1" ref="s1.w1.m2"/>; see also <cite doc="Text 1" ref="s1"/> again, '
            '<cite doc="Nope" ref="s1"/> (no such document), <cite doc="Text 1" ref="s9"/> (no such sentence) and '
            '<cite doc="Text 1"/> (no reference).')
    out = resolve_citations(w, text)
    assert [c['key'] for c in out] == ['<cite doc="Text 1" ref="s1"/>',
                                       '<cite ref="s2.w1" doc=\'Text 1\'></cite>',
                                       '<cite doc="Text 1" ref="s1.w1.m2"/>']
    a, b, m = out
    assert (a['document_id'], a['document_name'], a['sentence_id'], a['sentence'], a['focus']) == \
        ('d1', 'Text 1', 's-1', 1, [])
    assert a['text'] == 'Ali-di gam akuna.' and a['fields'] == [{'field': 'Translation', 'value': 'Ali saw a fish.'}]
    # Cells and tiers follow the Analyze grid: orthographies, word fields, morphemes, morpheme fields.
    assert a['words'][0] == {'index': 1, 'surface': 'Ali-di', 'begin': 0, 'seg': 'Ali-di',
                             'lines': [{'field': 'IPA', 'value': 'alidi'}, {'field': 'Gloss', 'value': 'Ali'},
                                       {'field': 'Morph Gloss', 'value': 'Ali-ERG'}]}
    assert a['tiers'] == [{'name': 'IPA', 'kind': 'orthography'}, {'name': 'Gloss', 'kind': 'word'},
                          {'name': 'Morphemes', 'kind': 'morphemes'}, {'name': 'Morph Gloss', 'kind': 'morpheme'}]
    # begin rides along so a card's link can land on the word in the editor.
    assert a['words'][1] == {'index': 2, 'surface': 'gam', 'begin': 7, 'seg': None, 'lines': []}
    assert (b['sentence'], b['focus'], b['words'][0]['seg']) == (2, [{'word': 1, 'morpheme': None}], 'Gam=ar')
    # A morpheme citation shows its sentence, pointing inside the word it is in.
    assert (m['sentence'], m['focus']) == (1, [{'word': 1, 'morpheme': 2}])
    assert resolve_citations(w, 'no citations here') == []


def test_a_citation_may_highlight_several_words_and_morphemes():
    from plaid_agent.igt.citations import parse_refs, resolve_citations
    assert parse_refs('s3.w2, w5') == ['s3.w2', 's3.w5']
    assert parse_refs('s3.w2.m1 m3') == ['s3.w2.m1', 's3.w2.m3']  # each part inherits what it leaves out
    # A reference is 1-BASED, so a zero is not a place. Read as "absent" it
    # turned one reference into a different, valid-looking one: `s3.w0` became
    # the whole of s3, and `s3.w0.m1` became `s3.m1`, which this very function
    # refuses.
    import pytest as _pytest
    for bad in ('s0', 's3.w0', 's0.w1', 's3.w0.m1'):
        with _pytest.raises(ValueError):
            parse_refs(bad)
    assert parse_refs('s3') == ['s3']
    w = ws()
    out = resolve_citations(w, '<cite doc="Text 1" ref="s1.w1.m2,w2"/> then <cite doc="Text 1" ref="s1.w9,w1"/>')
    a, b = out
    assert a['focus'] == [{'word': 1, 'morpheme': 2}, {'word': 2, 'morpheme': None}]
    # Morpheme rows come piece by piece for a word whose morphemes are named,
    # so the card can mark the morpheme rather than the whole word.
    assert a['words'][0]['morphs'] == ['Ali', 'di'] and a['words'][0]['joiners'] == ['-']
    assert a['words'][0]['lines'][-1] == {'field': 'Morph Gloss', 'value': 'Ali-ERG', 'parts': ['Ali', 'ERG']}
    assert 'morphs' not in a['words'][1] and 'parts' not in b['words'][0]['lines'][-1]
    # A reference that does not resolve is dropped, the rest of the citation stands.
    assert b['focus'] == [{'word': 1, 'morpheme': None}]
    assert resolve_citations(w, '<cite doc="Text 1" ref="s9.w1,s1.w1"/>')[0]['sentence'] == 1


def test_citations_come_back_in_the_order_written_and_stop_at_the_read_budget():
    from plaid_agent.igt import citations as C
    w = ws()
    call_tool(w, 'read_document', {'document': 'd1'})
    # Tags, the old braces and bare references interleave: the reader's cards
    # follow the reply, so the order is the order they are written in.
    out = C.resolve_citations(w, 'first s2, then {{Text 1 s1.w1}}, last <cite doc="Text 1" ref="s1.w2"/>')
    assert [c['key'] for c in out] == ['s2', '{{Text 1 s1.w1}}', '<cite doc="Text 1" ref="s1.w2"/>']
    # A stray word inside a reference list is skipped, not fatal to the citation.
    assert C.parse_refs('s3.w2 and w5') == ['s3.w2', 's3.w5']


def test_citations_do_not_fetch_more_documents_than_the_budget():
    from fixtures import document_raw
    from plaid_agent.core.limits import CITE_DOC_BUDGET
    from plaid_agent.igt.citations import resolve_citations
    docs = {}
    for i in range(CITE_DOC_BUDGET + 3):
        raw = document_raw()
        raw['id'], raw['name'] = f'd{i}', f'Text {i}'
        docs[raw['id']] = raw
    w = scan_ws(FakeClient(documents=docs))
    text = ' '.join(f'<cite doc="Text {i}" ref="s1"/>' for i in range(CITE_DOC_BUDGET + 3))
    # The user is waiting on the reply: cite from what was read, plus a few
    # fetches; the rest stay plain text.
    assert len(resolve_citations(w, text)) == CITE_DOC_BUDGET
    w2 = scan_ws(FakeClient(documents=docs))
    call_tool(w2, 'read_document', {'document': 'd9'})  # already read: not counted against the budget
    assert len(resolve_citations(w2, text)) == CITE_DOC_BUDGET + 1


def test_documents_sharing_a_name_are_printed_and_cited_by_id():
    from fixtures import document_raw
    from plaid_agent.igt.citations import resolve_citations
    docs = {}
    for i, name in enumerate(['Text 1', 'Text 1', 'Text 2'], 1):
        raw = document_raw()
        raw['id'], raw['name'] = f'd{i}', name
        docs[raw['id']] = raw
    w = scan_ws(FakeClient(documents=docs))
    # Nothing forbids two documents with one name, so a reference to either
    # names it by id; the unique name still prints as itself.
    assert (w.corpus.ref_name('d1'), w.corpus.ref_name('d2'), w.corpus.ref_name('d3')) == ('d1', 'd2', 'Text 2')
    out = call_tool(w, 'search', {'pattern': 'gam'})
    assert '"d1" s1.w2 gam' in out and '"d2" s1.w2 gam' in out and '"Text 2" s1.w2 gam' in out
    assert 'Document "Text 1" id=d2:' in call_tool(w, 'read_document', {'document': 'd2'})
    assert 'Document "Text 2": ' in call_tool(w, 'read_document', {'document': 'd3'})
    # Naming the shared name is refused, with the ids to pick from.
    assert 'Several documents are named "Text 1"; use an id: d1, d2' in call_tool(
        w, 'read_document', {'document': 'Text 1'})
    # A citation by that id resolves and still shows the reader the name.
    cites = resolve_citations(w, 'see <cite doc="d2" ref="s1"/>, not <cite doc="Text 1" ref="s1"/>')
    assert [(c['key'], c['document_id'], c['document_name']) for c in cites] == [
        ('<cite doc="d2" ref="s1"/>', 'd2', 'Text 1')]
    # The person approving a plan sees the id too, but only where it is needed.
    call_tool(w, 'respell', {'document': 'd1', 'ref': 's1.w2', 'new_text': 'gham'})
    assert w.ops[-1]['label'] == 'Text 1 (d1) s1.w2: respell "gam" → "gham"'
    call_tool(w, 'respell', {'document': 'd3', 'ref': 's2.w1', 'new_text': 'Gham-ar'})
    assert w.ops[-1]['label'] == 'Text 2 s2.w1: respell "Gam-ar" → "Gham-ar"'


def test_bare_references_are_citations_when_one_document_was_read():
    from plaid_agent.igt.citations import resolve_citations
    w = ws()
    assert resolve_citations(w, 'see s1.w2 and s2') == []  # nothing read yet: ambiguous, left alone
    call_tool(w, 'read_document', {'document': 'd1'})
    out = resolve_citations(w, 'Relatives: <cite doc="Text 1" ref="s1"/>; cf. the data in s1.w2, s1.w1.m1, s2 and '
                               's9 (none), not words2 or x.s1')
    assert [(c['key'], c['sentence'], c['focus']) for c in out] == [
        ('<cite doc="Text 1" ref="s1"/>', 1, []), ('s1.w2', 1, [{'word': 2, 'morpheme': None}]),
        ('s1.w1.m1', 1, [{'word': 1, 'morpheme': 1}]), ('s2', 2, [])]
    # A tag with no doc= means the one document too.
    assert [c['sentence'] for c in resolve_citations(w, 'see <cite ref="s2"/>')] == [2]


def test_prompt_teaches_cite_tags_and_the_old_braces_still_resolve():
    from plaid_agent.igt.prompt import build_system_prompt
    from plaid_agent.igt.citations import resolve_citations
    w = ws()
    prompt = build_system_prompt(w.project)
    assert '<cite doc="Text 1"' in prompt and 'Demo' in prompt and '{project_name}' not in prompt
    # A worked example must NAME something inside a sentence. The forms were
    # listed and never demonstrated once, and the model wrote whole-sentence
    # refs back: a citation that highlights nothing is the feature not working,
    # and it looked like the highlighting had broken.
    worked = re.findall(r'<cite doc="[^"]*" ref="([^"]*)"/>', prompt)
    assert any('.w' in r for r in worked), f'no worked example names a word or morpheme: {worked}'
    assert any('.m' in r for r in worked), f'no worked example names a morpheme: {worked}'
    assert any(re.fullmatch(r's\d+', r) for r in worked), f'and one still names a whole sentence: {worked}'
    out = resolve_citations(w, 'see {Text 1 s2} and {{Text 1 s1.w1}}')
    assert [(c['key'], c['sentence']) for c in out] == [('{Text 1 s2}', 2), ('{{Text 1 s1.w1}}', 1)]


def test_list_documents_pages_and_filters_and_overview_caps():
    from fixtures import document_raw
    from plaid_agent.core.limits import OVERVIEW_DOCS
    docs = {}
    total = 105   # more than the overview names, and enough for a "Text 10x" page
    for i in range(total):
        raw = document_raw()
        raw['id'] = f'd{i}'
        raw['name'] = f'Text {i:03d}'
        raw['metadata'] = {'Date': '2020' if i % 2 else '2021'}
        docs[raw['id']] = raw
    c = FakeClient(documents=docs)
    w = scan_ws(c)
    ov = call_tool(w, 'project_overview', {})
    assert f'Documents ({total}): first {OVERVIEW_DOCS} by name; list_documents' in ov
    assert f'Text {OVERVIEW_DOCS - 1:03d}' in ov and f'Text {OVERVIEW_DOCS:03d}' not in ov
    out = call_tool(w, 'list_documents', {'pattern': 'Text 10', 'limit': 2})
    assert out.startswith('5 documents matching, showing 1-2:') and 'Text 100' in out and 'list_documents(offset=2)' in out
    out = call_tool(w, 'list_documents', {'pattern': 'Text 10', 'limit': 2, 'offset': 4})
    assert 'showing 5-5' in out and 'Text 104' in out and 'offset=' not in out
    out = call_tool(w, 'list_documents', {'metadata_field': 'Date', 'value': '2021', 'limit': 500})
    assert out.startswith('53 documents matching:')
    assert 'No document metadata field "Genre"' in call_tool(w, 'list_documents', {'metadata_field': 'Genre', 'value': 'x'})


def test_parsed_documents_are_cached_across_workspaces_by_version(fresh_document_cache):
    from plaid_agent.igt import workspace as T
    from fixtures import document_raw
    c = FakeClient()
    c.no_doc_cache = False
    c._documents['d1']['version'] = 3
    a = scan_ws(c)
    d = a.doc('d1')
    b = scan_ws(c)
    assert b.doc('d1') is d  # a second turn reuses the parsed document
    # A newer version is fetched afresh and replaces the cached one.
    raw = document_raw()
    raw['version'] = 4
    c._documents['d1'] = raw
    w = scan_ws(c)
    fresh = w.doc('d1')
    assert fresh is not d and fresh.version == 4 and T._DOC_CACHE.get(('d1', 4)) is fresh


def test_a_large_group_of_like_changes_is_stored_as_one_op_and_applies_whole(monkeypatch):
    """A bulk respell cost over a kilobyte per word in the record, so a plan
    at the bulk cap could not be saved. Like ops fold into one stored op with
    the id lists; approval expands it again."""
    from plaid_agent.core import plan as core_plan
    from plaid_agent.igt.plan import execute_plan, summarize
    monkeypatch.setattr(core_plan, 'COMPACT_ABOVE', 2)
    w = scan_ws(FakeClient())
    call_tool(w, 'set_field', {'document': 'Text 1', 'refs': ['s1.w2', 's1.w3', 's2.w1'], 'field': 'Gloss', 'value': 'X'})
    payload = w.plan_payload()
    assert len(payload['ops']) == 1 and len(payload['changes']) == 1
    group = payload['ops'][0]
    assert group['compact'] and group['count'] == 3 and group['items']['token_id'] == ['w-2', 'w-3', 'w-4']
    # One change made three times is its count alone.
    assert group['label'] == 'Text 1: 3 × Gloss = "X"'
    assert payload['changes'][0]['where']['kind'] == 'document'
    assert payload['changes'][0]['change'] == '3 × Gloss = "X"'
    assert payload['summary'] == summarize(payload['ops']) == '3 field values'
    counts = execute_plan(w.client, payload['ops'], source='s', label='l')
    assert counts == {'field values': 3}


def test_a_read_that_does_not_fit_says_so_and_where_to_continue(monkeypatch):
    """The header said s1-s40 while the text was cut off inside sentence nine."""
    from plaid_agent.core import tools as core_tools
    w = scan_ws(FakeClient())
    whole = call_tool(w, 'read_document', {'document': 'Text 1'})
    assert '\n[s2]' in whole, 'the fixture needs two sentences for this'
    monkeypatch.setattr(core_tools, 'RENDER_BUDGET', whole.index('\n[s2]') + 200)
    out = call_tool(w, 'read_document', {'document': 'Text 1'})
    assert 'Showing s1-s1. The rest did not fit in one call.' in out
    assert 'read_document with from_sentence=2 for the next batch' in out
    assert '[s2]' not in out and '[truncated' not in out
    # Named sentences say which did not fit, and nothing about a range.
    out = call_tool(w, 'read_document', {'document': 'Text 1', 'sentences': ['s1', 's2']})
    assert 'Showing s1. Not shown, as they did not fit: s2. Ask for them in another call.' in out
    assert '[s2]' not in out and 'from_sentence' not in out


def test_hits_from_one_document_are_capped_and_the_rest_counted():
    from plaid_agent.igt.queries import _hit_lines
    w = scan_ws(FakeClient())
    c = w.corpus
    doc = w.doc('d1')
    words = [wd for s in doc.sentences for wd in s.words]
    rows = [[{'id': wd.id, 'document': 'd1', 'value': wd.surface}] for wd in words]
    lines = _hit_lines(c, rows, 0, 40, per_doc=1)
    assert len(lines) == 2 and lines[0].startswith('s1.w1 ')
    assert lines[1] == f'  … {len(words) - 1} more in this document (name the document to see them all)'


def _engine_for_replace(w, spans, metadata=None):
    """A fake engine answering the query path's replace: (span id, value, doc, token id) rows.
    Each span carries ``metadata`` when given (none is a person's work)."""
    extra = {} if metadata is None else {'metadata': metadata}

    def query(body):
        if body.get('return') == 'entities':
            return {'return': 'entities', 'results': [
                [{'id': i, 'value': v, 'document': d, 'layer': 'sl-gloss', 'tokens': [t], **extra},
                 {'id': t, 'document': d, 'value': 'x', 'begin': 0, 'end': 1}] for i, v, d, t in spans]}
        return {'return': 'aggregate', 'results': []}
    w.client.query = query


def test_a_replacement_past_the_cap_is_one_predicate_op_resolved_at_approval(monkeypatch):
    """The query path read every value of a field and refused past the cap, so
    a field with more values than the cap could never be replaced in. Now the
    engine applies the pattern, and more changes than fit span by span are
    stored as one op and found again at approval."""
    from plaid_agent.igt import bulk
    from plaid_agent.igt.plan import execute_plan, summarize
    monkeypatch.setattr(bulk, 'PLAN_MAX_OPS', 2)
    w = scan_ws(FakeClient())
    w.prefer_scan = False
    spans = [('s1', 'Ali', 'd1', 'w-1'), ('s2', 'ali-x', 'd1', 'w-2'), ('s3', 'ALI', 'd1', 'w-3')]
    _engine_for_replace(w, spans)
    out = call_tool(w, 'replace_in_field', {'field': 'Gloss', 'pattern': 'ali', 'replacement': 'Bob'})
    assert 'One change covering 3 changes to Gloss values.' in out
    assert '\nIn 1 document: "Text 1" 3.\n' in out
    assert 'more' not in out  # three lines of sample, and no "… -5 more" under it
    op = w.ops[0]
    assert op['kind'] == 'bulk_scope' and op['tool'] == 'replace_in_field' and op['count'] == 3
    assert op['documents'] == ['d1'] and op['args']['pattern'] == 'ali'
    assert summarize(w.ops) == '3 field values'
    payload = w.plan_payload()
    assert [d['id'] for d in payload['documents']] == ['d1']
    counts = execute_plan(w.client, payload['ops'], source='s', label='l', project=w.project)
    assert counts == {'field values': 3}
    assert w.client.updates('spans') == [('s1', 'Bob'), ('s2', 'Bob-x'), ('s3', 'Bob')]
    # Under the cap, the same call stages per-span ops, as the scan path does.
    monkeypatch.setattr(bulk, 'PLAN_MAX_OPS', 3000)
    w.ops.clear()
    call_tool(w, 'replace_in_field', {'field': 'Gloss', 'pattern': 'ali', 'replacement': 'Bob'})
    assert [op['kind'] for op in w.ops] == ['set_span'] * 3



def test_a_respelling_past_the_cap_is_one_op_that_a_reshape_cannot_join(monkeypatch):
    from plaid_agent.igt import bulk
    from plaid_agent.igt.plan import execute_plan, summarize, validate_ops
    monkeypatch.setattr(bulk, 'PLAN_MAX_OPS', 1)
    w = scan_ws(FakeClient())
    w.prefer_scan = False

    def query(body):
        find = body.get('find') or []
        if body.get('return') == 'entities' and find == ['?t']:
            return {'return': 'entities', 'results': [
                [{'id': 'w-1', 'value': 'Alidi', 'document': 'd1', 'text': 't1', 'begin': 0, 'end': 5}],
                [{'id': 'w-3', 'value': 'akuna', 'document': 'd1', 'text': 't1', 'begin': 10, 'end': 15}]]}
        return {'return': 'entities', 'results': []}
    w.client.query = query
    out = call_tool(w, 'respell_all', {'pattern': 'a', 'replacement': 'ä', 'lexicon': False, 'morpheme_forms': False})
    assert 'One change covering 2 changes to words' in out
    op = w.ops[0]
    assert op['kind'] == 'bulk_scope' and op['tool'] == 'respell_all' and op['counts'] == {'respell': 2}
    assert summarize(w.ops) == '2 respellings'
    # Nothing that reshapes a reached document may join the plan, in either order.
    assert 'corpus-wide change' in call_tool(w, 'split_word', {'document': 'Text 1', 'ref': 's1.w1', 'at': 2})
    with pytest.raises(ValueError, match='meet for the first time'):
        validate_ops(w.ops + [{'kind': 'split_word', 'word_id': 'w-1', 'position': 2, 'morpheme_ids': [], 'doc': 'd1'}])
    counts = execute_plan(w.client, w.plan_payload()['ops'], source='s', label='l', project=w.project)
    assert counts.get('respellings') == 2


def test_igt_search_and_concordance_match_case_only_when_asked():
    w = scan_ws(FakeClient())
    assert 's1.w1' in call_tool(w, 'search', {'pattern': 'ali', 'where': 'baseline'})
    assert 'No hits' in call_tool(w, 'search', {'pattern': 'ali', 'where': 'baseline', 'case_sensitive': True}) \
        or call_tool(w, 'search', {'pattern': 'ali', 'where': 'baseline', 'case_sensitive': True}).startswith('0 ')
    assert 's1.w1' in call_tool(w, 'search', {'pattern': 'Ali', 'where': 'baseline', 'case_sensitive': True})


def test_read_document_reads_the_sentences_named_in_one_call():
    """igt's read_document took only a range, so a reader that knew it wanted
    s2 had to page to it. It is core's read_document now, as in ud and umr,
    rendered by this app's workspace."""
    from plaid_agent.core import tools as core_tools
    assert _IMPL['read_document'] is core_tools.read_document
    w = ws()
    out = call_tool(w, 'read_document', {'document': 'Text 1', 'sentences': ['s2']})
    assert 'Showing s2.' in out and '[s2]' in out and '[s1]' not in out
    out = call_tool(w, 'read_document', {'document': 'Text 1', 'sentences': ['s2', 's1.w2']})
    assert 'Showing s2, s1.' in out and out.index('[s2]') < out.index('[s1]')
    out = call_tool(w, 'read_document', {'document': 'Text 1', 'sentences': ['s9']})
    assert 'None of those sentences exist.' in out and '[s' not in out
    # The range still reads as before, with the document's id where its name is shared.
    out = call_tool(w, 'read_document', {'document': 'Text 1', 'from_sentence': 's2'})
    assert 'Showing s2-s2.' in out and '[s1]' not in out
    assert 'from_sentence=5 is past the end' in call_tool(w, 'read_document',
                                                          {'document': 'Text 1', 'from_sentence': 5})
    spec = next(t['function'] for t in TOOLS if t['function']['name'] == 'read_document')
    assert 'sentences' in spec['parameters']['properties'] and 'sentences' in spec['description']


def _two_documents(name='Elicited: LLEC Wordlist'):
    """The fixture's Text 1 and a copy of it as d2, named with a ": " in it."""
    import copy
    c = FakeClient()
    d2 = copy.deepcopy(c._documents['d1'])
    d2['id'], d2['name'] = 'd2', name
    c._documents['d2'] = d2
    return c


def test_a_group_line_reads_each_change_where_its_label_says_and_counts_repeats(monkeypatch):
    """The group line split every member's label at its first ": ", which in a
    document named "Elicited: LLEC Wordlist" lands inside the name, so the
    card read 'LLEC Wordlist s33.w4.m2 "do": Gloss …'. And one change made
    twenty times was written out five times over."""
    from plaid_agent.core import plan as core_plan
    from plaid_agent.core.plan import change_of
    monkeypatch.setattr(core_plan, 'COMPACT_ABOVE', 2)
    c = FakeClient()
    c._documents['d1']['name'] = 'Elicited: LLEC Wordlist'
    w = scan_ws(c)
    call_tool(w, 'set_orthography', {'document': 'd1', 'refs': ['s1.w1', 's1.w2', 's1.w3', 's2.w1'],
                                      'orthography': 'IPA', 'value': 'q'})
    # The group's line, over changes that differ and changes that repeat.
    from plaid_agent.igt.workspace import compact_spec
    members = [dict(op, doc='d1') for op in w.ops]
    line = compact_spec(w)['set_orthography']['label'](members[0], members)
    assert line['label'] == 'Elicited: LLEC Wordlist: 4 changes: IPA "alidi" → "q"; 3 × IPA = "q"'
    assert change_of(line) == '4 changes: IPA "alidi" → "q"; 3 × IPA = "q"'
    # On the card, s1.w1 replaces a person's IPA and keeps a row of its own,
    # and the one change made three times is its count alone.
    payload = w.plan_payload()
    own, group = payload['ops']
    assert own['label'].endswith('IPA "alidi" → "q"') and own.get('replaces_work')
    assert group['label'] == 'Elicited: LLEC Wordlist: 3 × IPA = "q"'
    change = payload['changes'][1]
    assert change['where']['document_name'] == 'Elicited: LLEC Wordlist'
    assert change['change'] == '3 × IPA = "q"'


def test_every_member_change_is_read_off_its_label_not_split(monkeypatch):
    """Each kind that folds into a group gets its change from `labelled`, so
    the card shows the change after a document name holding ": " too."""
    from plaid_agent.core.plan import change_of
    c = FakeClient()
    c._documents['d1']['name'] = 'A: B'
    w = scan_ws(c)
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'X'})
    call_tool(w, 'set_orthography', {'document': 'd1', 'refs': ['s1.w1'], 'orthography': 'IPA', 'value': 'q'})
    call_tool(w, 'respell', {'document': 'd1', 'ref': 's1.w2', 'new_text': 'gham'})
    call_tool(w, 'set_morpheme', {'document': 'd1', 'ref': 's2.w1.m2', 'form': 'är'})
    kinds = {op['kind'] for op in w.ops}
    assert {'set_span', 'set_orthography', 'respell', 'set_morpheme_form'} <= kinds
    for op in w.ops:
        if op['kind'] in ('set_span', 'set_orthography', 'respell', 'set_morpheme_form'):
            assert op['label'].startswith('A: B s') and change_of(op) and not change_of(op).startswith('B ')
    payload = w.plan_payload()
    for op, ch in zip(payload['ops'], payload['changes']):
        assert ch['change'] == change_of(op)


def test_a_bulk_answer_counts_its_changes_by_document(monkeypatch):
    """replace_in_field listed 8 of 20 changes and "… 12 more", and the model
    made up a breakdown by document three times over. The answer now gives
    the exact count in each document, under the cap and past it."""
    from plaid_agent.igt import bulk
    from plaid_agent.core import plan as core_plan
    monkeypatch.setattr(core_plan, 'COMPACT_ABOVE', 2)
    w = scan_ws(_two_documents())
    w.prefer_scan = False
    spans = [('s1', 'NOM.PAT', 'd1', 'w-1'), ('s2', 'NOM.PAT', 'd2', 'w-2'), ('s3', 'NOM.PAT', 'd2', 'w-3'),
             ('s4', 'NOM.PAT', 'd2', 'w-4')]
    # Machine output, so no change replaces a person's work and all four fold.
    _engine_for_replace(w, spans, metadata={'prov': 'inferred', 'provSource': 'service:x'})
    out = call_tool(w, 'replace_in_field', {'field': 'Gloss', 'pattern': '.', 'replacement': ':'})
    assert out.startswith('Planned 4 changes')
    assert '\nIn 2 documents: "Elicited: LLEC Wordlist" 3, "Text 1" 1.\n' in out
    group, = w.plan_payload()['ops']
    assert group['label'] == '4 changes in 2 documents: 4 × Gloss "NOM.PAT" → "NOM:PAT"'
    # Past the cap: one stored op, and the same counts.
    monkeypatch.setattr(bulk, 'PLAN_MAX_OPS', 2)
    w.ops.clear()
    out = call_tool(w, 'replace_in_field', {'field': 'Gloss', 'pattern': '.', 'replacement': ':'})
    assert '\nIn 2 documents: "Elicited: LLEC Wordlist" 3, "Text 1" 1.\n' in out


def test_a_scan_bulk_answer_counts_by_document_too():
    """The scan path's ops name no document of their own; the count finds it."""
    w = scan_ws(FakeClient())
    out = call_tool(w, 'replace_in_field', {'document': 'd1', 'field': 'Gloss', 'pattern': '.*', 'regex': True,
                                            'whole': True, 'replacement': 'Z'})
    n = len(w.ops)
    assert n and f'\nIn 1 document: "Text 1" {n}.\n' in out


def test_dropping_a_new_entry_takes_a_multi_word_expression_on_it_along():
    """drop_planned took a word's own link to a dropped new entry along, but
    not a multi-word expression's, which approval then failed on after the
    first batch had landed. And approval refuses such a link up front, before
    anything is written, however the plan came to hold it."""
    import pytest
    from plaid_agent.igt.plan import execute_plan
    w = ws()
    out = call_tool(w, 'create_entry', {'form': 'Ali gam', 'type': 'phrase'})
    key = out.split('entry_id: ')[1].split()[0]
    call_tool(w, 'link_phrase', {'document': 'd1', 'refs': ['s1.w1', 's1.w2'], 'entry_id': key})
    assert [o['kind'] for o in w.ops] == ['create_entry', 'link_phrase']
    orphan = dict(w.ops[1])
    out = call_tool(w, 'drop_planned', {'indexes': [1]})
    assert 'Links to the dropped new entries were dropped with them' in out and w.ops == []
    c = FakeClient()
    with pytest.raises(ValueError, match='does not create'):
        execute_plan(c, [orphan], source='s', label='l')
    assert c.batches == []


def test_a_form_that_carries_its_affix_marker_gets_no_second_one():
    """Forms imported as FLEx writes them alone ("m-", "-ar") carry their
    marker, and every place the assistant joins a word's pieces added its own:
    "m--ohpmooit" on plan cards, reads and cited examples (H8 polish). The
    joint is left out where a side already has a marker, as plaid-igt's
    joinerBetween does."""
    from fixtures import document_raw
    from plaid_agent.igt.citations import _word_payload
    from plaid_agent.igt.project import join_morphemes, segmentation
    assert join_morphemes([('m-', 'prefix'), ('ohpmooit', None)]) == 'm-ohpmooit'
    assert join_morphemes([('i', None), ('=m', 'enclitic'), ('-haa', 'suffix')]) == 'i=m-haa'
    assert join_morphemes([('ka', None), ('ni', 'enclitic')]) == 'ka=ni'
    raw = document_raw()
    morphs = raw['text_layers'][0]['token_layers'][2]['tokens']
    morphs[1]['metadata'] = {'form': '-di', 'morphType': 'suffix'}
    w = scan_ws(FakeClient(documents={'d1': raw}))
    word = w.doc('d1').sentences[0].words[0]
    assert segmentation(word) == 'Ali-di'
    assert _word_payload(word, w.project, pieces=True)['joiners'] == ['']
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w1',
                                        'morphemes': [{'form': 'Al'}, {'form': '-i', 'type': 'suffix'}]})
    assert 'Planned' in out
    assert 'Ali-di → Al-i' in w.ops[0]['label'] and '--' not in w.ops[0]['label']


def test_a_value_copied_back_from_a_read_is_written_without_its_mark():
    """The ~ and ^ a read appends are display only (F7 ruling): a field value,
    a morpheme gloss, the last form of a segmentation and a link's entry
    copied back with their marks are written without them."""
    w = scan_ws(FakeClient())
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w3'], 'field': 'Gloss', 'value': 'say~'})
    assert w.ops[-1]['value'] == 'say'
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w3', 'morphemes': [
        {'form': 'aku', 'fields': {'Morph Gloss': 'say^'}}, {'form': 'na~', 'fields': {'Morph Gloss': 'PST~'}}]})
    op = w.ops[-1]
    assert [m['form'] for m in op['morphemes']] == ['aku', 'na']
    assert [fv['value'] for m in op['morphemes'] for fv in m['fields']] == ['say', 'PST']
    out = call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w2'], 'entry_form': 'gam^',
                                      'entry_gloss': 'fish'})
    assert 'Planned' in out, out
    assert 'only a review mark' in call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w3'],
                                                                'field': 'Gloss', 'value': '^'})


def test_a_value_off_a_layers_stored_list_is_refused_while_planning():
    """R1-DEBT-CORE-4: the server refuses a person's value off a layer's
    value-set rule, and an approved plan with one failed whole. The plan
    refuses it as it is staged, from the rule stored on the layer, so the
    model can correct itself: a set_field, a value inside a planned
    analysis, and an edit of a planned morpheme."""
    from fixtures import MGLOSS
    c = FakeClient(documents={'d1': _machine_doc()})
    w = scan_ws(c)
    w.project.field_by_layer(MGLOSS).value_sets = [{'type': 'value-set', 'values': ['Ali', 'PST', 'ERG'],
                                                    'delimiters': '.'}]
    out = call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1.m1'], 'field': 'Morph Gloss',
                                     'value': 'Ali.XX'})
    assert '"Ali.XX" is not on the list Morph Gloss is held to' in out and w.ops == []
    out = call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1.m1'], 'field': 'Morph Gloss',
                                     'value': 'Ali.PST'})
    assert out.startswith('Planned') and len(w.ops) == 1
    out = call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's1.w3', 'morphemes': [
        {'form': 'x', 'fields': {'Morph Gloss': 'ZZ'}}]})
    assert '"ZZ" is not on the list Morph Gloss is held to' in out and len(w.ops) == 1
    # A gloss rule leaves the other fields alone.
    out = call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'ZZ'})
    assert out.startswith('Planned')
