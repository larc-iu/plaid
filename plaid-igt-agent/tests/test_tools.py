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


def test_field_values_histogram():
    w = ws()
    out = call_tool(w, 'field_values', {'field': 'Morph Gloss'})
    assert 'Morph Gloss (Morpheme field): 2 values, 2 distinct, 3 empty' in out
    assert '  1\tERG' in out


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
    # clearing
    call_tool(w, 'set_field', {'document': 'd1', 'refs': 's1.w1', 'field': 'Gloss', 'value': ''})
    assert w.ops[-1]['value'] == '' and '(cleared)' in w.ops[-1]['label']
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
    assert w.ops[-1] == {'kind': 'unlink', 'link_id': 'l-2', 'label': 'Text 1 s1.w1.m2 "di": unlink "-di"'}
    # new entry, then link to it in the same plan
    out = call_tool(w, 'create_entry', {'form': 'akun', 'fields': {'gloss': 'see'}, 'type': 'stem'})
    key = out.split('entry_id="')[1].rstrip('").')
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



def test_search_missing_lists_items_without_a_value():
    w = ws()
    out = call_tool(w, 'search', {'where': 'Gloss', 'missing': True})
    assert out.startswith('3 items without a Gloss value')  # w2, w3 of s1 and w1 of s2
    assert 's1.w2 gam || Ali-di gam akuna.' in out and 's2.w1 Gam-ar' in out and 's1.w1' not in out
    out = call_tool(w, 'search', {'where': 'Morph Gloss', 'missing': True})
    assert '3 items' in out and 's1.w2 gam (m1 gam)' in out and 's1.w3 akuna (no morphemes yet)' in out
    out = call_tool(w, 'search', {'where': 'Translation', 'missing': True})
    assert out.startswith('1 items') and 's2 | Gam-ar.' in out
    assert 'needs a field name' in call_tool(w, 'search', {'missing': True})
    assert 'Give a pattern' in call_tool(w, 'search', {})


def test_concordance_brackets_hits_and_tallies_patterns():
    w = ws()
    out = call_tool(w, 'concordance', {'pattern': 'ar'})
    assert out.startswith('1 occurrence of "ar" in morpheme.')
    assert '  1\tGam=[ar]' in out  # pattern tally, clitic joiner kept
    assert 's2.w1 # [Gam-ar] # | seg=Gam=[ar] || Gam-ar.' in out
    out = call_tool(w, 'concordance', {'pattern': 'ERG', 'where': 'Morph Gloss'})
    assert '1 occurrence of "ERG" in Morph Gloss' in out
    assert 'seg=Ali-[di] | Morph Gloss=Ali-[ERG] | Gloss=Ali' in out and '# [Ali-di] gam' in out
    out = call_tool(w, 'concordance', {'pattern': 'gam', 'where': 'baseline'})
    assert '1 occurrence' in out and 'Ali-di [gam] akuna' in out  # whole-form: "Gam-ar" is not "gam"
    assert '2 occurrences' in call_tool(w, 'concordance', {'pattern': '^gam', 'where': 'baseline', 'regex': True})
    assert call_tool(w, 'concordance', {'pattern': 'zzz'}) == 'No occurrences of "zzz".'
    assert 'sentence fields' in call_tool(w, 'concordance', {'pattern': 'x', 'where': 'Translation'})


def test_analyses_of_tallies_word_and_morpheme_analyses():
    out = call_tool(ws(), 'analyses_of', {'form': 'gam'})
    assert 'Word "gam": 1 occurrence, 1 distinct analysis:' in out  # "Gam-ar" is a different surface
    assert '  1\t(unanalyzed)  e.g. s1.w2' in out
    assert 'Morpheme "gam": 2 occurrences' in out
    assert '(unglossed)  [only in word]  e.g. s1.w2.m1 (gam)' in out
    assert '[first in word]  e.g. s2.w1.m1 (Gam=ar)' in out
    out = call_tool(ws(), 'analyses_of', {'form': 'di'})
    assert 'Word "di": no occurrences.' in out
    assert 'type=suffix | Morph Gloss=ERG | link=-di  [last in word]  e.g. s1.w1.m2 (Ali-di)' in out


def test_lexicon_entry_detail_with_links_and_examples():
    out = call_tool(ws(), 'lexicon_entry', {'entry_form': 'Ali'})
    assert out.startswith('Entry "Ali" (id vi-ali)') and '  gloss: Ali' in out and '  pos: N' in out
    assert 'Linked from 1 word and 0 morphemes.' in out and 's1.w1 Ali-di | seg=Ali-di' in out
    out = call_tool(ws(), 'lexicon_entry', {'entry_form': '-di'})
    assert 'Linked from 0 words and 1 morpheme.' in out
    assert 'Several entries match "gam"' in call_tool(ws(), 'lexicon_entry', {'entry_form': 'gam'})


def test_check_consistency_reports_variants_multi_values_and_link_gaps():
    c = FakeClient()
    doc = c._documents['d1']
    # add a second gloss on m-2 ('gam' -> 'Fish') and a variant spelling of ERG on another morpheme
    layer = doc['text_layers'][0]['token_layers'][2]
    layer['span_layers'][0]['spans'] += [
        {'id': 'sp-m2', 'value': 'fish', 'tokens': ['m-2']},
        {'id': 'sp-m4a', 'value': 'Fish', 'tokens': ['m-4a']},
        {'id': 'sp-m4b', 'value': 'erg', 'tokens': ['m-4b']},
    ]
    w = Workspace(c, load_project(c, 'p1'))
    out = call_tool(w, 'check_consistency', {'field': 'Morph Gloss'})
    assert 'Consistency of Morph Gloss (Morpheme field): 5 values, 5 distinct.' in out
    assert '2 values spelled more than one way:' in out
    assert 'fish (1) / Fish (1)' in out and 'ERG (1) / erg (1)' in out
    assert 'gam: fish (1), Fish (1)' in out  # same form, two values
    assert '4 annotated but not linked to the lexicon: s1.w1.m1 Ali (Ali); s1.w2.m1 gam (fish); s2.w1.m1 Gam (Fish); s2.w1.m2 ar (erg)' in out
    out = call_tool(w, 'check_consistency', {'field': 'Translation'})
    assert 'No spelling or case variants' in out and 'linked' not in out


def test_recent_changes_and_plan_status():
    w = ws()
    out = call_tool(w, 'recent_changes', {})
    assert out.startswith('2 most recent changes (newest first):')
    assert '2026-08-29 18:51  Luke G: Assistant: 2 field values  ["Text 1"]  (2 ops)' in out
    assert '2026-08-28 10:00  Someone: Create project "Demo"' in out
    assert '1 most recent change' in call_tool(w, 'recent_changes', {'document': 'Text 1'})
    assert call_tool(w, 'plan_status', {}) == 'The plan is empty.'
    call_tool(w, 'set_field', {'document': 'd1', 'refs': 's1.w2', 'field': 'Gloss', 'value': 'fish'})
    assert call_tool(w, 'plan_status', {}) == '1 planned change (nothing written yet):\n  1. Text 1 s1.w2 "gam": Gloss = "fish"'


def test_document_metadata_and_create_document_plans():
    w = ws()
    assert 'No document metadata field "Speaker"' in call_tool(w, 'set_document_metadata', {'document': 'd1', 'field': 'Speaker', 'value': 'x'})
    call_tool(w, 'set_document_metadata', {'document': 'd1', 'field': 'date', 'value': '2021'})
    assert w.ops[-1] == {'kind': 'set_doc_metadata', 'document_id': 'd1', 'field': 'Date', 'value': '2021',
                         'label': 'Text 1: Date "2020" → "2021"'}
    out = call_tool(w, 'create_document', {'name': 'Text 2', 'text': 'Ali-di gam, akuna!\n  Gam-ar.\n', 'metadata': {'date': '2022'}})
    assert out.startswith('Planned 1 change') and '(2 sentences, 6 words will be tokenized.)' in out
    assert w.ops[-1]['kind'] == 'create_document' and w.ops[-1]['metadata'] == {'Date': '2022'}
    assert w.ops[-1]['label'] == 'New document "Text 2": 2 sentences, 6 words'  # hyphen splits: no whitelist here
    assert 'already exists' in call_tool(w, 'create_document', {'name': 'Text 1', 'text': 'x'})
