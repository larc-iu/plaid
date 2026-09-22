"""The skeleton-from-glosses service, driven end to end on the same harness
as the draft service: no model, so the whole run is the reading of the
glosses and links and the writing of the anchors and nodes.

Run: pytest -q services/tests, from plaid-umr. Runs from the base env.
"""

import json
import pathlib

import pytest
from plaid_client import testing as servicetest

import test_umr_draft_llm as draft_tests

SERVICES = pathlib.Path(__file__).resolve().parent.parent

boot = servicetest.load_service(SERVICES / 'umr_bootstrap_igt.py')

DOC = draft_tests.DOC
PROJECT = draft_tests.PROJECT
REQUEST = {'document_id': DOC, 'project_id': PROJECT,
           'scope': 'document', 'sentence': 1, 'overwrite': False}

#: "The dog barks": "The" is glossed DET only (no lexical part, no node),
#: "dog" is glossed dog-PL, and "barks" is linked to the sense "bark 1" under
#: the headword "bark" and glossed bark.PRS, which makes it the root.
GLOSSES = [
    {'id': 'g1', 'tokens': ['w1'], 'value': 'DET'},
    {'id': 'g2', 'tokens': ['w2'], 'value': 'dog-PL'},
    {'id': 'g3', 'tokens': ['w3'], 'value': 'bark.PRS'},
]
VOCAB = {'id': 'v1', 'name': 'Lexicon', 'items': [
    {'id': 'i1', 'form': 'bark', 'metadata': {}},
    {'id': 'i2', 'form': 'barking', 'metadata': {'parent': 'i1'}},
]}


def _document(**kwargs):
    document = draft_tests._document(gloss_spans=kwargs.pop('gloss_spans', GLOSSES), **kwargs)
    word_layer = document['text_layers'][0]['token_layers'][1]
    word_layer['vocabs'] = [{'id': 'v1', 'vocab_links': [
        {'id': 'l1', 'vocab_item': {'id': 'i2', 'form': 'barking'}, 'tokens': ['w3']},
    ]}]
    return document


class _Client(draft_tests._Client):
    def __init__(self, documents, project=None, fails=None):
        super().__init__(documents, project=project, fails=fails)
        self.vocab_layers = self._Vocabs()

    class _Vocabs:
        def get(self, vocab_id, **kwargs):
            assert kwargs.get('include_items') is True
            return VOCAB


def _project():
    return {'id': PROJECT, 'name': 'UMR', 'config': {}, 'vocabs': [{'id': 'v1'}]}


def _service(*, documents=None, fails=None):
    service = boot.UmrBootstrapService()
    service.client = _Client(documents or [_document()], project=_project(), fails=fails)
    return service


def _ops(client, kind):
    return [op for payload in client.payloads(kind) for op in payload]


# --- reading a gloss ------------------------------------------------------------

def test_a_gloss_is_read_into_its_lexical_part_and_its_attributes():
    table = boot.ABBREVIATIONS
    assert boot.read_gloss('bark.PRS', table) == {
        'lexical': 'bark', 'attrs': [], 'eventive': True}
    assert boot.read_gloss('3SG', table) == {
        'lexical': None, 'attrs': [(':refer-person', '3rd'), (':refer-number', 'singular')],
        'eventive': False}
    assert boot.read_gloss('go=1PL.IRR', table)['attrs'] == [
        (':refer-person', '1st'), (':refer-number', 'plural')]
    assert boot.read_gloss('go=1PL.IRR', table)['eventive'] is True
    assert boot.read_gloss('NEG', table)['attrs'] == [(':polarity', '-')]
    # An upper-case piece the table does not know is grammatical, not a word.
    assert boot.read_gloss('DET', table)['lexical'] is None
    # A capitalised word is a word.
    assert boot.read_gloss('Lindsay', table)['lexical'] == 'Lindsay'
    assert boot.concept_from('Go Away ') == 'go-away'


def test_a_language_table_adds_and_removes_abbreviations(tmp_path):
    path = tmp_path / 'arapaho.json'
    path.write_text(json.dumps({'OBV': [':refer-person', '4th'], 'AFF': ['root'], 'Q': None}))
    table = boot.load_abbreviations(str(path))
    assert table['OBV'] == (':refer-person', '4th')
    assert table['AFF'] == ('root',)
    assert 'Q' not in table
    assert table['SG'] == (':refer-number', 'singular')


def test_a_sense_takes_its_headword():
    assert boot.headwords_of([VOCAB]) == {'i1': 'bark', 'i2': 'bark'}


# --- the run ------------------------------------------------------------------------

def test_the_skeleton_is_one_anchored_node_per_glossed_or_linked_word():
    service = _service()
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == []
    [result] = helper.results
    assert (result['drafted'], result['skipped'], result['failed']) == (1, 0, 0)
    assert result['notice']['level'] == 'success'

    anchors = _ops(service.client, 'tokens.bulk_create')
    assert [(a['begin'], a['end']) for a in anchors] == [(4, 7), (8, 13)]
    nodes = _ops(service.client, 'spans.bulk_create')
    assert [n['value'] for n in nodes] == ['dog', 'bark']
    dog, bark = [n['metadata']['umr'] for n in nodes]
    assert dog['attrs'] == [{'rel': ':refer-number', 'value': 'plural', 'order': 0}]
    assert 'root' not in dog
    # The linked word takes the HEADWORD, not the sense's form, and its tense
    # gloss makes it the root.
    assert bark['root'] is True and bark['attrs'] == []
    assert dog['var'] == 's1d' and bark['var'] == 's1b'
    # Machine-made, and no relations at all.
    assert nodes[0]['metadata']['prov'] == 'inferred'
    assert nodes[0]['metadata']['provSource'].startswith('service:')
    assert service.client.payloads('relations.bulk_create') == []
    assert [kind for kind, _ in service.client.writes] == [
        'tokens.bulk_create', 'spans.bulk_create']


def test_the_first_node_is_the_root_when_no_gloss_carries_tense():
    glosses = [{'id': 'g2', 'tokens': ['w2'], 'value': 'dog'},
               {'id': 'g3', 'tokens': ['w3'], 'value': 'bark'}]
    document = _document(gloss_spans=glosses)
    document['text_layers'][0]['token_layers'][1]['vocabs'] = []
    service = _service(documents=[document])
    servicetest.run(service, REQUEST)
    nodes = _ops(service.client, 'spans.bulk_create')
    assert [n['value'] for n in nodes] == ['dog', 'bark']
    assert nodes[0]['metadata']['umr'].get('root') is True


def test_a_sentence_with_nothing_to_go_on_is_a_counted_failure():
    document = _document(gloss_spans=[])
    document['text_layers'][0]['token_layers'][1]['vocabs'] = []
    service = _service(documents=[document])
    helper = servicetest.run(service, REQUEST)
    [result] = helper.results
    assert (result['drafted'], result['failed']) == (0, 1)
    assert result['notice']['level'] == 'warning'
    assert 'no word has a vocabulary link or a gloss' in result['notice']['message']
    assert service.client.writes == []


def _with_graph(node_metadata):
    """The document with sentence 1 already annotated: one node on the last
    word, whose provenance is the caller's."""
    return _document(
        node_tokens=[('n1', 8, 13)],
        concept_spans=[{'id': 'c1', 'tokens': ['n1'], 'value': 'bark-01',
                        'metadata': {'umr': {'var': 's1b', 'attrs': []}, **node_metadata}}])


def test_a_sentence_with_a_graph_is_skipped_unless_overwritten():
    document = _with_graph({'prov': 'inferred', 'provSource': 'service:umr-draft-llm'})
    service = _service(documents=[document])
    helper = servicetest.run(service, REQUEST)
    [result] = helper.results
    assert (result['drafted'], result['skipped']) == (0, 1)
    assert service.client.writes == []

    service = _service(documents=[document])
    servicetest.run(service, {**REQUEST, 'overwrite': True})
    assert [kind for kind, _ in service.client.writes] == [
        'tokens.bulk_delete', 'tokens.bulk_create', 'spans.bulk_create']
    # The freed variable is used again rather than s1b2.
    assert [n['metadata']['umr']['var'] for n in _ops(service.client, 'spans.bulk_create')] == [
        's1d', 's1b']


# The same rule as the drafting service, from the same reader: `overwrite`
# replaces the machine's own skeletons, never a person's graph.
@pytest.mark.parametrize('node_metadata, why', [
    ({}, 'hand-made'),
    ({'prov': 'inferred', 'provSource': 'service:umr-bootstrap-igt', 'provConfirmed': True},
     'verified'),
    ({'prov': 'contributed', 'provSource': 'user:a@b.com'}, 'contributed'),
])
def test_overwrite_keeps_a_sentence_a_person_built_or_confirmed(node_metadata, why):
    service = _service(documents=[_with_graph(node_metadata)])
    helper = servicetest.run(service, {**REQUEST, 'overwrite': True})

    [result] = helper.results
    assert (result['drafted'], result['skipped'], result['kept']) == (0, 0, 1), why
    assert service.client.writes == [], f'a {why} graph is not deleted'
    assert result['notice'] == {'level': 'warning', 'title': 'Document not modified',
                                'message': 'Kept 1 sentence a person had worked on.'}
