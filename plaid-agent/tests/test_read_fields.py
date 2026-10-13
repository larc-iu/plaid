"""read_document's ``fields`` and read_sentences: in projects with 15 to 20
word fields one read fitted 3 to 12 sentences, and reading a search's hits
across documents cost a call per document (2026-10-12 survey)."""
import copy

import pytest

from fixtures import FakeClient, document_raw, fake_ws, project_raw
from plaid_agent.igt import reads
from plaid_agent.igt.project import FORMAT_LEGEND
from plaid_agent.igt.toolkit import call_tool


def two_documents():
    second = {**copy.deepcopy(document_raw()), 'id': 'd2', 'name': 'Text 2'}
    return {'d1': document_raw(), 'd2': second}


def ws(**kw):
    return fake_ws(FakeClient(**kw))


def test_fields_show_only_what_they_name():
    out = call_tool(ws(), 'read_document', {'document': 'd1', 'fields': ['Gloss']})
    assert 'Only these are shown: Gloss. Anything else is left out, not missing.' in out
    out = out.split('\nShowing ')[1]
    assert '  w1 Ali-di | Gloss=Ali\n' in out
    assert 'seg=' not in out and 'Morph Gloss' not in out and 'IPA=' not in out and 'link=' not in out
    assert 'Translation' not in out


def test_only_sentence_fields_leave_out_the_word_lines():
    out = call_tool(ws(), 'read_document', {'document': 'd1', 'fields': ['Translation']}).split('\nShowing ')[1]
    assert '[s1] Ali-di gam akuna.\n  Translation: Ali saw a fish.\n[s2] Gam-ar.' in out
    assert ' w1 ' not in out


def test_segmentation_links_and_orthographies_are_named_as_a_model_guesses():
    out = call_tool(ws(), 'read_document', {'document': 'd1', 'fields': ['segmentation', 'links', 'orthographies']})
    assert '  w1 Ali-di | seg=Ali-di types=?,suffix | IPA=alidi | link=Ali | mlinks=m2:-di\n' in out
    out = call_tool(ws(), 'read_document', {'document': 'd1', 'fields': ['ipa']})
    assert '  w1 Ali-di | IPA=alidi\n' in out


def test_a_name_two_fields_share_shows_both():
    p = copy.deepcopy(project_raw())
    p['text_layers'][0]['token_layers'][2]['span_layers'][0]['name'] = 'Gloss'
    out = call_tool(ws(project=p), 'read_document', {'document': 'd1', 'fields': ['Gloss']})
    assert 'Only these are shown: Gloss (Word), Gloss (Morpheme).' in out
    assert '  w1 Ali-di | Gloss (Morpheme)=Ali-ERG | Gloss (Word)=Ali\n' in out


def test_an_unknown_name_is_refused_with_every_name():
    out = call_tool(ws(), 'read_document', {'document': 'd1', 'fields': ['Gloss', 'POS']})
    assert out == ('Error: fields: nothing is called "POS". The names are Word: Gloss; Morpheme: Morph Gloss; '
                   'Sentence: Translation; orthographies: IPA; "segmentation", "links".')


def test_without_fields_the_read_is_as_before():
    w = ws()
    assert call_tool(w, 'read_document', {'document': 'd1', 'fields': []}) == \
        call_tool(ws(), 'read_document', {'document': 'd1'})


def test_read_sentences_reads_several_documents_under_their_own_headers():
    w = ws(documents=two_documents())
    w.reads = []
    out = call_tool(w, 'read_sentences', {'items': [{'document': 'Text 1', 'sentences': ['s2']},
                                                    {'document': 'Text 2', 'sentences': ['s1', 's2']}],
                                          'fields': ['Translation']})
    first, second = out.split('\n\n')
    assert first.startswith('Document "Text 1"') and FORMAT_LEGEND in first and 'Showing s2.' in first
    assert second.startswith('Document "Text 2"') and 'Format' not in second and 'Showing s1, s2.' in second
    assert w.reads == [{'n': 1, 'unit': 'sentence', 'which': '2 in Text 1'},
                       {'n': 2, 'unit': 'sentence', 'which': '1–2 in Text 2'}]


def test_read_sentences_lists_what_did_not_fit(monkeypatch):
    w = ws(documents=two_documents())
    one = len(call_tool(ws(), 'read_document', {'document': 'd1', 'sentences': ['s1']}))
    monkeypatch.setattr(reads, 'RENDER_BUDGET', one + 50)
    out = call_tool(w, 'read_sentences', {'items': [{'document': 'Text 1', 'sentences': ['s1']},
                                                    {'document': 'Text 2', 'sentences': ['s1', 's2']}]})
    assert 'Document "Text 2"' not in out
    assert out.endswith('Not read, as they did not fit: "Text 2" s1, s2. Ask for them in another read_sentences '
                        'call.')


@pytest.mark.parametrize('items', [None, [], [{'document': 'Text 1'}], ['Text 1']])
def test_read_sentences_shows_the_shape_it_takes(items):
    assert call_tool(ws(), 'read_sentences', {'items': items}) == f'Error: {reads.ITEMS_SHAPE}'
