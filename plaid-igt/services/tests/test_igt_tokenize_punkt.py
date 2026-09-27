"""The Punkt tokenizer's refusals, with NLTK replaced (no model, no server).
Run: pytest plaid-igt/services/tests"""
import pathlib
import types

from plaid_client import testing as servicetest
from plaid_client.workflows.messages import SETUP_INCOMPLETE

SERVICES = pathlib.Path(__file__).resolve().parent.parent

fake_nltk = types.ModuleType('nltk')
fake_nltk.data = types.SimpleNamespace(load=lambda path: object())
fake_nltk.download = lambda *a, **k: None

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
