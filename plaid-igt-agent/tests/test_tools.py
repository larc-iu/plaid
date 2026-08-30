from fixtures import FakeClient

from plaid_igt_agent.project import load_project
from plaid_igt_agent.tools import Workspace, call_tool, TOOLS, _IMPL


def ws():
    c = FakeClient()
    return Workspace(c, load_project(c, 'p1'))


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
    assert call_tool(w, 'field_values', {'field': 'Morph Gloss'}) == 'Unknown tool field_values'


def test_read_lexicon():
    out = call_tool(ws(), 'read_lexicon', {'pattern': 'gam'})
    assert 'Lexicon "Lexicon": 4 entries, 2 matching' in out


def test_set_field_plans_create_update_clear_and_respects_scope():
    w = ws()
    out = call_tool(w, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1', 's1.w2'], 'field': 'Gloss', 'value': 'X'})
    assert out.startswith('Planned 2 changes')
    assert w.ops[0] == {'kind': 'set_span', 'layer_id': 'sl-gloss', 'token_id': 'w-1', 'span_id': 'sp-g1', 'value': 'X',
                        'label': 'Text 1 s1.w1 "Ali-di": Gloss "Ali" → "X"'}
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
                                            'value': 'alidi', 'label': 'Text 1 s1.w2 "gam": IPA = "alidi"'}
    assert 'No orthography named "Cyr"' in call_tool(w, 'set_orthography', {'document': 'd1', 'refs': 's1.w1', 'orthography': 'Cyr', 'value': 'x'})
    call_tool(w, 'respell', {'document': 'd1', 'ref': 's1.w3', 'new_text': 'akun'})
    assert w.ops[-1] == {'kind': 'respell', 'text_id': 'text1', 'begin': 11, 'end': 16, 'value': 'akun',
                         'label': 'Text 1 s1.w3: respell "akuna" → "akun"'}
    # ambiguous entry -> candidates with ids
    out = call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w2'], 'entry_form': 'gam'})
    assert 'Several entries match "gam"' in out and 'id=vi-gam gam | gloss=fish' in out
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': ['s1.w2'], 'entry_id': 'vi-gam'})
    assert w.ops[-1] == {'kind': 'link', 'token_id': 'w-2', 'item_id': 'vi-gam', 'new_entry_key': None,
                         'existing_link_id': None, 'label': 'Text 1 s1.w2 "gam": link "gam"'}
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
    assert call_tool(w, 'nope', {}) == 'Unknown tool nope'
    assert call_tool(w, 'set_field', {'document': 'd1'}).startswith('Error:')
    assert call_tool(w, 'search', {'pattern': '(', 'regex': True}).startswith('Error: Bad regex')


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
    c._project['vocabs'][0]['config'] = {'igt': {'fields': {'gloss': {'inline': True}, 'pos': {'inline': False}}}}
    w2 = Workspace(c, load_project(c, 'p1'))
    assert 'has no entry field "definition"' in call_tool(w2, 'create_entry', {'form': 'x', 'fields': {'definition': 'y'}})
    call_tool(w2, 'create_entry', {'form': 'x', 'fields': {'Gloss': 'y'}})
    assert w2.ops[-1]['metadata'] == {'gloss': 'y'}
    assert 'entry fields: gloss, pos' in call_tool(w2, 'project_overview', {})


def test_homograph_numbers_pick_an_entry():
    c = FakeClient()
    c._lexicon['items'][2]['metadata']['homograph'] = 1
    c._lexicon['items'][3]['metadata']['homograph'] = 2
    w = Workspace(c, load_project(c, 'p1'))
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
    w = Workspace(c, load_project(c, 'p1'))
    out = call_tool(w, 'confirm', {'document': 'd1', 'refs': ['s1.w1']})
    assert 'Planned 1 change' in out and '5 annotations will be marked verified' in out
    op = w.ops[0]
    assert op['kind'] == 'confirm'
    assert sorted(op['span_ids']) == ['sp-g1', 'sp-m1b'] and op['token_ids'] == ['m-1b'] and sorted(op['link_ids']) == ['l-1', 'l-2']
    assert op['label'] == 'Text 1 s1.w1 "Ali-di": confirm 2 values, 2 links, 1 segmentation'
    # Field-restricted: only that field's spans, no links or segmentations.
    w2 = Workspace(c, load_project(c, 'p1'))
    call_tool(w2, 'confirm', {'document': 'd1', 'refs': ['s1'], 'field': 'Morph Gloss'})
    assert w2.ops[0]['span_ids'] == ['sp-m1b'] and not w2.ops[0]['token_ids'] and not w2.ops[0]['link_ids']
    # Whole document: one op.
    w3 = Workspace(c, load_project(c, 'p1'))
    out = call_tool(w3, 'confirm', {'document': 'd1'})
    assert len(w3.ops) == 1 and w3.ops[0]['label'].startswith('Text 1: confirm 2 values, 2 links, 2 segmentations')
    assert '6 annotations' in out
    # Nothing unverified there.
    assert call_tool(w3, 'confirm', {'document': 'd1', 'refs': ['s1.w3']}).startswith('Nothing to confirm')


def test_discard_analysis_mirrors_the_editor():
    c = FakeClient(documents={'d1': _machine_doc()})
    w = Workspace(c, load_project(c, 'p1'))
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
