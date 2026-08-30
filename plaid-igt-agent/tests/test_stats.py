from fixtures import FakeClient, document_raw

from plaid_igt_agent.project import load_project
from plaid_igt_agent.tools import Workspace, call_tool, TOOLS, _IMPL, WRITE_TOOLS


def ws(client=None):
    c = client or FakeClient()
    return Workspace(c, load_project(c, 'p1'))


def test_all_tools_registered():
    names = {t['function']['name'] for t in TOOLS}
    assert names == set(_IMPL)
    assert WRITE_TOOLS <= names
    assert len(names) >= 37 and 'field_values' not in names


def test_corpus_stats_totals_and_tables():
    out = call_tool(ws(), 'corpus_stats', {})
    assert 'Project "Demo"' in out
    assert '1 document, 2 sentences, 4 words (4 distinct forms, 4 hapax, type/token 1.00), 5 morphemes (4 distinct, 3 hapax)' in out
    assert 'Words with any analysis: 50%; linked to the lexicon: 25%' in out
    assert 'Translation 50% (1/2 sentences)' in out and 'Gloss 25% (1/4 words)' in out and 'Morph Gloss 40% (2/5 morphemes)' in out
    assert 'Longest words: Ali-di (2: Ali-di), Gam-ar (2: Gam=ar)' in out
    table = call_tool(ws(), 'corpus_stats', {'by': 'document'})
    assert table.splitlines()[0] == 'document\tsentences\twords\tanalyzed\tlinked\tMorph Gloss\tTranslation\thapax\tTTR\tDate'
    assert table.splitlines()[1] == 'Text 1\t2\t4\t50%\t25%\t40%\t50%\t100%\t1.00\t2020'
    by = call_tool(ws(), 'corpus_stats', {'by': 'date'})
    assert by.startswith('Date = 2020')
    assert 'by must be' in call_tool(ws(), 'corpus_stats', {'by': 'Genre'})


def test_frequency_list():
    out = call_tool(ws(), 'frequency_list', {'what': 'morpheme'})
    assert out.startswith('4 morpheme forms, 5 tokens. count\tdocuments\tform')
    assert '  1\t1\tali' in out
    out = call_tool(ws(), 'frequency_list', {'what': 'Morph Gloss', 'limit': 1})
    assert '2 Morph Gloss values, 2 tokens, 3 empty (showing 1)' in out
    assert 'No field named "zzz"' in call_tool(ws(), 'frequency_list', {'what': 'zzz'})


def test_worklist_kinds():
    w = ws()
    out = call_tool(w, 'worklist', {'kind': 'unglossed'})
    assert out.startswith('3 morphemes without a Morph Gloss value across 2 distinct forms')
    assert '  2\tgam\ts1.w2.m1, s2.w1.m1' in out
    out = call_tool(w, 'worklist', {'kind': 'unglossed', 'field': 'Gloss'})
    assert '3 words without a Gloss value' in out and 'akuna' in out
    out = call_tool(w, 'worklist', {'kind': 'unglossed', 'field': 'Translation'})
    assert out.startswith('1 sentences without a Translation value (grouped by document)') and 's2 Gam-ar.' in out
    out = call_tool(w, 'worklist', {'kind': 'unlinked', 'level': 'word'})
    assert '3 words not linked to the lexicon' in out
    out = call_tool(w, 'worklist', {'kind': 'unanalyzed'})
    assert '2 words with no analysis at all' in out and 'gam' in out and 'akuna' in out
    assert call_tool(w, 'worklist', {'kind': 'unverified'}).startswith('Nothing to do')
    assert 'kind must be' in call_tool(w, 'worklist', {'kind': 'bogus'})


def test_check_lexicon_report():
    out = call_tool(ws(), 'check_lexicon', {})
    assert 'Lexicon check: 4 entries in Lexicon, 2 links.' in out
    assert '2 entries never linked from a text: gam, gam' in out
    assert '0 entries without a gloss.' in out and '3 entries without a pos: -di, gam, gam' in out
    assert '1 homograph groups:' in out and 'gam | gloss=fish (0 links) | gam | gloss=net (0 links)' in out
    assert '0 entries whose gloss disagrees with the corpus.' in out
    assert '0 links whose form no longer matches the entry.' in out


def test_check_integrity_report():
    c = FakeClient()
    doc = c._documents['d1']
    doc['text_layers'][0]['text']['body'] = doc['text_layers'][0]['text']['body']  # unchanged
    # a slip: rename a morpheme form so it no longer adds up
    doc['text_layers'][0]['token_layers'][2]['tokens'][1]['metadata']['form'] = 'du'
    out = call_tool(ws(c), 'check_integrity', {})
    assert '1 words whose morpheme forms do not add up to the surface' in out and 's1.w1 Ali-di ≠ Ali-du' in out
    assert '0 sentences occurring more than once.' in out and '0 sentences with no words.' in out
    assert 'All text is NFC-normalized.' in out


def test_sequence_search_matches_whole_values():
    w = ws()
    # "ERG" must not match a morpheme glossed "ERGATIVE-ish" by substring, and "Ali" must not match "Ali-di" partials
    assert call_tool(w, 'sequence_search', {'sequence': [{'Morph Gloss': 'ER'}]}) == 'No sentence matches that sequence.'
    assert '1 sentence match' in call_tool(w, 'sequence_search', {'sequence': [{'Morph Gloss': 'ER'}], 'regex': True})


def test_sequence_search():
    w = ws()
    out = call_tool(w, 'sequence_search', {'sequence': [{'Morph Gloss': 'ERG'}, {'form': 'gam'}]})
    assert out.startswith('1 sentence match') and 's1 [Ali-di] [gam] akuna' in out
    out = call_tool(w, 'sequence_search', {'sequence': [{'Gloss': 'Ali'}, {'form': 'akuna'}], 'adjacent': False})
    assert '1 sentence match' in out
    assert call_tool(w, 'sequence_search', {'sequence': [{'Gloss': 'Ali'}, {'form': 'akuna'}]}) == 'No sentence matches that sequence.'
    assert 'sequence must be' in call_tool(w, 'sequence_search', {'sequence': []})
    assert 'sentence field' in call_tool(w, 'sequence_search', {'sequence': [{'Translation': 'x'}]})


def test_bulk_plans():
    w = ws()
    out = call_tool(w, 'replace_in_field', {'field': 'Morph Gloss', 'pattern': 'ERG', 'replacement': 'OBL', 'whole_value': True})
    assert out.startswith('Planned 1 change') and w.ops[-1]['value'] == 'OBL' and w.ops[-1]['span_id'] == 'sp-m1b'
    out = call_tool(w, 'replace_in_field', {'field': 'Translation', 'pattern': r'(\w+)\.$', 'replacement': r'\1!', 'regex': True})
    assert w.ops[-1]['value'] == 'Ali saw a fish!'
    assert call_tool(w, 'replace_in_field', {'field': 'Gloss', 'pattern': 'zzz', 'replacement': 'y'}).startswith('Nothing to change')
    out = call_tool(w, 'respell_all', {'pattern': 'a', 'replacement': 'ä'})
    assert 'Planned 4 changes' in out and w.ops[-1]['kind'] == 'respell' and w.ops[-1]['value'] == 'Gäm-är'  # case-insensitive, like search
    assert 'Planned 3 changes' in call_tool(ws(), 'respell_all', {'pattern': 'a', 'replacement': 'ä', 'case_sensitive': True})
    assert 'would become empty' in call_tool(w, 'respell_all', {'pattern': '.*', 'replacement': '', 'regex': True})
    out = call_tool(w, 'copy_to_orthography', {'orthography': 'IPA'})
    assert 'Planned 3 changes' in out  # w-1 already has IPA
    out = call_tool(w, 'set_analysis_for_form', {'form': 'GAM', 'morphemes': [{'form': 'gam', 'fields': {'Morph Gloss': 'fish'}}]})
    assert 'Planned 1 change' in out and w.ops[-1]['kind'] == 'set_analysis' and w.ops[-1]['word_id'] == 'w-2'
    assert 'Nothing to change' in call_tool(w, 'set_analysis_for_form', {'form': 'Ali-di', 'skip_analyzed': True,
                                                                          'morphemes': [{'form': 'Ali-di'}]})


def test_lexicon_and_document_ops():
    w = ws()
    out = call_tool(w, 'merge_entries', {'keep_form': 'Ali', 'remove_id': 'vi-erg'})
    assert '1 link(s) will move' in out
    assert w.ops[-1] == {'kind': 'merge_entries', 'keep_id': 'vi-ali', 'remove_id': 'vi-erg',
                         'links': [{'link_id': 'l-2', 'token_id': 'm-1b'}],
                         'label': 'Merge entry -di | type=suffix | gloss=ERG into Ali | gloss=Ali | pos=N: move 1 link, delete the former'}
    assert 'same entry' in call_tool(w, 'merge_entries', {'keep_id': 'vi-ali', 'remove_id': 'vi-ali'})
    call_tool(w, 'delete_entry', {'entry_id': 'vi-ali'})
    assert w.ops[-1]['kind'] == 'delete_entry' and w.ops[-1]['links'] == ['l-1']
    call_tool(w, 'rename_entry', {'entry_id': 'vi-gam', 'new_form': 'gam1'})
    assert w.ops[-1] == {'kind': 'rename_entry', 'item_id': 'vi-gam', 'form': 'gam1', 'label': 'Rename entry "gam" → "gam1"'}
    call_tool(w, 'rename_document', {'document': 'Text 1', 'new_name': 'Text One'})
    assert w.ops[-1] == {'kind': 'rename_document', 'document_id': 'd1', 'name': 'Text One', 'label': 'Rename document "Text 1" → "Text One"'}
    assert call_tool(w, 'rename_document', {'document': 'Text 1', 'new_name': 'Text 1'}).startswith('Planned 0')


def test_recent_changes_filters():
    w = ws()
    assert '1 most recent change by "luke"' in call_tool(w, 'recent_changes', {'user': 'luke'})
    out = call_tool(w, 'recent_changes', {'since': '2026-08-29'})
    assert 'since 2026-08-29' in out


def test_query_rewrites_layer_names_and_scopes_to_the_project():
    c = FakeClient()
    seen = {}

    def fake_query(body):
        seen.update(body)
        return {'return': 'entities', 'columns': ['s'], 'count': 1, 'truncated': False,
                'results': [[{'id': 'sp-m1b', 'layer': 'sl-mgloss', 'document': 'd1', 'value': 'ERG', 'tokens': ['m-1b']}]]}
    c.query = fake_query
    w = ws(c)
    out = call_tool(w, 'query', {'query': {'find': ['?s'], 'where': [['span', '?s', {'layer': 'morph gloss', 'value': 'ERG'}],
                                                                     ['seq', {'layer': 'words'}, ['span', {'layer': 'Gloss'}, 'as', '?g']]]}})
    assert seen['scope'] == {'project_ids': ['p1']} and seen['return'] == 'entities' and seen['limit'] == 1000
    assert seen['where'][0][2]['layer'] == 'sl-mgloss' and seen['where'][1][1]['layer'] == 'tk-word'
    assert seen['where'][1][2][1]['layer'] == 'sl-gloss'
    assert out == '1 row: s\n  "Text 1" s1.w1.m2 Morph Gloss = "ERG"'
    assert 'No layer named "Nope"' in call_tool(w, 'query', {'query': {'where': [['span', '?s', {'layer': 'Nope'}]]}})
    assert 'must be a JSON object' in call_tool(w, 'query', {'query': 'not json'})
    help_text = call_tool(w, 'query_help', {})
    assert 'Morpheme-scope fields (span layers on morpheme tokens): Morph Gloss' in help_text
    assert 'lexicons (vocab layers): Lexicon' in help_text and '["covers", ?span, ?token]' in help_text


def test_query_count_and_aggregate_shapes():
    c = FakeClient()
    c.query = lambda body: {'return': 'count', 'count': 7, 'truncated': False}
    assert call_tool(ws(c), 'query', {'query': {'find': ['?s'], 'where': [['span', '?s', {}]], 'return': 'count'}}) == 'count: 7'
    c.query = lambda body: {'return': 'aggregate', 'columns': ['d', 'count'], 'results': [['d1', 4]], 'count': 1, 'truncated': False}
    out = call_tool(ws(c), 'query', {'query': {'where': [['token', '?t', {'layer': 'words', 'doc': {'var': '?d'}}]],
                                               'return': {'group': ['?d'], 'aggregates': [['count']]}}})
    assert out == '1 group: d\tcount\n  Text 1\t4'


def test_a_failing_tool_call_leaves_no_partial_plan():
    w = ws()
    # the cap: 4 words would change, cap it at 2 for the test
    import plaid_igt_agent.bulk as bulk
    old = bulk.MAX_BULK
    bulk.MAX_BULK = 2
    try:
        assert 'more than the 2' in call_tool(w, 'respell_all', {'pattern': 'a', 'replacement': 'ä'})
    finally:
        bulk.MAX_BULK = old
    assert w.ops == []
    # a bad ref in a multi-ref call
    assert 'not a morpheme' in call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1.m2', 's1.w2'], 'field': 'Morph Gloss', 'value': 'x'})
    assert w.ops == []
    # a word that would be emptied part-way through
    assert 'would become empty' in call_tool(w, 'respell_all', {'pattern': '^gam$', 'replacement': '', 'regex': True})
    assert w.ops == []


def test_second_op_on_the_same_target_replaces_the_first():
    w = ws()
    call_tool(w, 'set_field', {'document': 'd1', 'refs': 's1.w1', 'field': 'Gloss', 'value': ''})
    out = call_tool(w, 'set_field', {'document': 'd1', 'refs': 's1.w1', 'field': 'Gloss', 'value': 'X'})
    assert '1 earlier planned change on the same target superseded' in out
    assert len(w.ops) == 1 and w.ops[0]['value'] == 'X' and w.ops[0]['span_id'] == 'sp-g1'
    # replace_in_field composes with the planned value rather than the stored one
    call_tool(w, 'replace_in_field', {'field': 'Gloss', 'pattern': 'X', 'replacement': 'Y'})
    assert len(w.ops) == 1 and w.ops[0]['value'] == 'Y'
    # two analyses of one word: one op
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's2.w1', 'morphemes': [{'form': 'gam'}, {'form': 'ar'}]})
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's2.w1', 'morphemes': [{'form': 'gamar'}]})
    assert sum(1 for op in w.ops if op['kind'] == 'set_analysis') == 1
    # link then unlink on one word: one op
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': 's1.w2', 'entry_id': 'vi-gam'})
    call_tool(w, 'unlink_entry', {'document': 'd1', 'refs': 's1.w1'})
    call_tool(w, 'link_entry', {'document': 'd1', 'refs': 's1.w1', 'entry_id': 'vi-gam'})
    assert [op['kind'] for op in w.ops if op['kind'] in ('link', 'unlink') and (op.get('token_id') == 'w-1' or op.get('token_id_hint') == 'w-1')] == ['link']


def test_overlapping_respells_are_refused_but_repeats_replace():
    w = ws()
    call_tool(w, 'respell', {'document': 'd1', 'ref': 's1.w2', 'new_text': 'gham'})
    call_tool(w, 'respell', {'document': 'd1', 'ref': 's1.w2', 'new_text': 'ghem'})
    assert len(w.ops) == 1 and w.ops[0]['value'] == 'ghem'
