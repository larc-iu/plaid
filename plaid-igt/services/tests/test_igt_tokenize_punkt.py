"""The Punkt tokenizer's refusals, with NLTK replaced (no model, no server).
Run: pytest plaid-igt/services/tests"""
import pathlib
import types

from plaid_client import testing as servicetest
from plaid_client.service import service_version
from plaid_client.workflows.messages import SETUP_INCOMPLETE

SERVICES = pathlib.Path(__file__).resolve().parent.parent

fake_nltk = types.ModuleType('nltk')
fake_nltk.data = types.SimpleNamespace(load=lambda path: object())
fake_nltk.download = lambda *a, **k: None
fake_nltk.__version__ = '3.9.1'

punkt = servicetest.load_service(SERVICES / 'igt_tokenize_punkt.py', {'nltk': fake_nltk})

REQUEST = {'document_id': 'd1', 'text_layer_id': 'textL',
           'primary_token_layer_id': 'wordL', 'sentence_layer_id': 'sentL'}


def _document(*, text_layer_id='textL', body='the dog barks'):
    return {'id': 'd1', 'version': 3, 'text_layers': [{
        'id': text_layer_id, 'name': 'Baseline',
        'config': {'plaid': {'role': 'baseline'}},
        'text': {'id': 'text-1', 'body': body},
        'token_layers': [],
    }]}


def _service(doc):
    service = punkt.NLTKTokenizerService()
    service.client = servicetest.FakeClient([doc])
    return service


def test_a_missing_text_layer_is_refused_with_the_shared_setup_line():
    service = _service(_document(text_layer_id='otherL'))
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == [SETUP_INCOMPLETE]
    assert 'textL' not in helper.errors[0] and 'd1' not in helper.errors[0]
    assert service.client.writes == []


def test_an_empty_document_is_refused_once():
    service = _service(_document(body='   '))
    helper = servicetest.run(service, REQUEST)

    assert len(helper.errors) == 1
    assert helper.errors[0].endswith('The document has no text.')
    assert 'd1' not in helper.errors[0]
    assert service.client.writes == []


def test_the_tokens_are_substrate_and_carry_no_provenance():
    # The provenance convention: word and sentence tokens are substrate and are
    # not stamped, as the built-in tokenizer does not stamp them. That the
    # tokens came from this service is the run's operation (service-run,
    # service:<id>) in the audit log.
    from plaid_client.workflows.tokenization import TokenSpan
    doc = _document()
    doc['text_layers'][0]['token_layers'] = [
        {'id': 'sentL', 'name': 'Sentences', 'config': {}, 'tokens': [
            {'id': 's0', 'begin': 0, 'end': 13, 'text': 'text-1', 'metadata': {}}]},
        {'id': 'wordL', 'name': 'Words', 'config': {}, 'tokens': []},
    ]
    service = _service(doc)
    # Two sentences, so the one the document has is replaced.
    service.tokenizer_model.tokenize_text = lambda text, language: (
        [TokenSpan('the dog', 0, 7), TokenSpan('barks', 8, 13)],
        [TokenSpan('the', 0, 3), TokenSpan('dog', 4, 7), TokenSpan('barks', 8, 13)])
    helper = servicetest.run(service, {**REQUEST, 'language': 'german'})

    assert helper.errors == []
    created = [op for kind, payload in service.client.writes if kind == 'tokens.bulk_create'
               for op in payload]
    made = sorted((op['token_layer_id'], op['begin'], op['end']) for op in created)
    assert [m for m in made if m[0] == 'wordL'] == [('wordL', 0, 3), ('wordL', 4, 7), ('wordL', 8, 13)]
    assert len([m for m in made if m[0] == 'sentL']) == 2
    assert all(not (op.get('metadata') or {}) for op in created), created
    assert service.client.operation_tags == [
        {'kind': 'service-run', 'ref': 'service:tok:nltk-punkt-tokenizer'}]
