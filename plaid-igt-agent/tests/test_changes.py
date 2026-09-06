"""Every planned change is located for the plan card: the document, the
sentence and word to link to, and the change without its location."""

from fixtures import FakeClient, scan_ws, VOCAB

from plaid_igt_agent.changes import describe_change, describe_changes
from plaid_igt_agent.tools import call_tool


def _plan(*calls):
    c = FakeClient()
    ws = scan_ws(c)
    for name, args in calls:
        call_tool(ws, name, args)
    return ws


def test_a_word_change_links_to_its_sentence_and_word():
    ws = _plan(('set_field', {'document': 'Text 1', 'refs': 's1.w2', 'field': 'Gloss', 'value': 'fish'}))
    [d] = describe_changes(ws, ws.ops)
    assert d['label'] == 'Text 1 s1.w2 "gam": Gloss = "fish"'
    assert d['where'] == {'kind': 'token', 'document_id': 'd1', 'document_name': 'Text 1', 'sentence_id': 's-1',
                          'sentence': 1, 'word': 2, 'morpheme': None, 'begin': 7, 'surface': 'gam'}
    assert d['change'] == 'Gloss = "fish"'


def test_morpheme_sentence_and_document_changes():
    ws = _plan(('set_field', {'document': 'Text 1', 'refs': 's1.w1.m2', 'field': 'Morph Gloss', 'value': 'DAT'}),
               ('set_field', {'document': 'Text 1', 'refs': 's2', 'field': 'Translation', 'value': 'Fish.'}),
               ('set_document_metadata', {'document': 'Text 1', 'field': 'Date', 'value': '2021'}),
               ('respell', {'document': 'Text 1', 'ref': 's1.w3', 'new_text': 'akun'}))
    m, s, doc, re_ = describe_changes(ws, ws.ops)
    assert m['where']['morpheme'] == 2 and m['where']['word'] == 1 and m['where']['surface'] == 'di'
    assert m['change'] == 'Morph Gloss "ERG" → "DAT"'
    assert s['where']['word'] is None and s['where']['sentence'] == 2 and s['where']['surface'] == 'Gam-ar.'
    assert s['change'] == 'Translation = "Fish."'
    assert doc['where'] == {'kind': 'document', 'document_id': 'd1', 'document_name': 'Text 1'}
    assert doc['change'] == 'Date "2020" → "2021"'
    assert re_['where']['word'] == 3 and re_['where']['begin'] == 11
    assert re_['change'] == 'respell "akuna" → "akun"'


def test_lexicon_changes_name_the_entry_and_its_lexicon():
    ws = _plan(('create_entry', {'form': 'akun', 'fields': {'pos': 'V'}}),
               ('set_entry_field', {'entry_id': 'vi-ali', 'field': 'pos', 'value': 'PN'}),
               ('rename_entry', {'entry_id': 'vi-erg', 'new_form': '-dee'}))
    new, field, rename = describe_changes(ws, ws.ops)
    assert new['where'] == {'kind': 'entry', 'vocab_id': VOCAB, 'vocab_name': 'Lexicon', 'item_id': None, 'form': 'akun'}
    assert new['change'].startswith('new entry')
    assert field['where']['item_id'] == 'vi-ali' and field['where']['form'] == 'Ali'
    assert field['change'] == 'pos "N" → "PN"'
    assert rename['where']['form'] == '-di' and rename['where']['vocab_id'] == VOCAB
    assert rename['change'] is None, 'a label without a location head is shown whole'


def test_a_document_not_loaded_is_named_alone():
    ws = _plan()
    op = {'kind': 'set_span', 'layer_id': 'sl-gloss', 'token_id': 'w-far', 'span_id': None, 'value': 'x',
          'doc': 'd9', 'label': '"Far away" "word": Gloss = "x"'}
    ws.corpus.doc_name = lambda did: 'Far away'
    ws.corpus.ref_name = lambda did: 'Far away'
    d = describe_change(ws, op)
    assert d['where'] == {'kind': 'document', 'document_id': 'd9', 'document_name': 'Far away'}
    assert d['change'] == 'Gloss = "x"'


def test_a_new_document_has_nowhere_to_link():
    ws = _plan(('create_document', {'name': 'Text 9', 'text': 'A b.'}))
    [d] = describe_changes(ws, ws.ops)
    assert d['where'] is None and d['change'] is None and d['label'].startswith('New document')


def test_the_plan_payload_carries_the_changes():
    ws = _plan(('set_field', {'document': 'Text 1', 'refs': ['s1.w2', 's1.w3'], 'field': 'Gloss', 'value': 'x'}))
    payload = ws.plan_payload()
    assert len(payload['changes']) == len(payload['ops']) == len(payload['labels']) == 2
    assert [c['where']['word'] for c in payload['changes']] == [2, 3]
