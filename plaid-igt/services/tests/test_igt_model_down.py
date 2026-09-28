"""The igt model services stop asking once the model has not answered two
sentences in a row, as the UMR draft does. With the endpoint down, a run used
to wait out two full deadlines on every sentence with the document locked
(REV-SERVICES Q1, 2026-09-28). The sentences it never asked about are reported
as failed, so the Auto-analyze summary counts them.

Run: pytest plaid-igt/services/tests"""

import pathlib

import pytest
from plaid_client import testing as servicetest
from plaid_client.workflows.llm import NOT_ASKED, ModelTimeout, Reply

SERVICES = pathlib.Path(__file__).resolve().parent.parent
translate = servicetest.load_service(SERVICES / 'igt_translate_llm.py')
analyze = servicetest.load_service(SERVICES / 'igt_analyze_llm.py')

N = 5
WORDS = ['ev', 'gel', 'su', 'kus', 'yol']


def _document():
    """Five one-word sentences, nothing analyzed or translated."""
    body = ' '.join(WORDS)
    sentences, words, morphs = [], [], []
    at = 0
    for i, w in enumerate(WORDS, 1):
        sentences.append({'id': f's{i}', 'begin': at, 'end': at + len(w)})
        words.append({'id': f'w{i}', 'begin': at, 'end': at + len(w), 'metadata': {}})
        morphs.append({'id': f'm{i}', 'begin': at, 'end': at + len(w), 'precedence': 1,
                       'metadata': {}})
        at += len(w) + 1
    return {'id': 'd1', 'version': 3, 'text_layers': [{
        'id': 'textL', 'text': {'id': 't', 'body': body},
        'token_layers': [
            {'id': 'sentL', 'tokens': sentences,
             'span_layers': [{'id': 'trL', 'name': 'Translation',
                              'config': {'igt': {'scope': 'Sentence'}}, 'spans': []}]},
            {'id': 'wordL', 'tokens': words, 'span_layers': [], 'vocabs': []},
            {'id': 'morphL', 'tokens': morphs,
             'span_layers': [{'id': 'glossL', 'name': 'Gloss',
                              'config': {'igt': {'scope': 'Morpheme'}}, 'spans': []}],
             'vocabs': []},
        ]}]}


REQUEST = {'document_id': 'd1', 'project_id': 'p1', 'word_token_layer_id': 'wordL',
           'morpheme_token_layer_id': 'morphL', 'sentence_token_layer_id': 'sentL',
           'language': 'Turkish', 'use_glosses': False}


class _Model:
    """One outcome per call, in order: a reply's text, or an exception."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    def complete(self, system, user, should_stop=None):
        self.calls += 1
        outcome = self.outcomes[self.calls - 1]
        if isinstance(outcome, BaseException):
            raise outcome
        return Reply(text=outcome)

    def describe(self):
        return {'model': 'fake/m'}

    def usage_line(self):
        return 'fake/m'


def _timeout():
    return ModelTimeout('The model did not answer within 120 seconds.')


def _service(module, cls, outcomes):
    service = getattr(module, cls)()
    service.model = _Model(outcomes)
    service.REQUEST_SECRETS = ()
    service.client = servicetest.FakeClient([_document()],
                                            project={'id': 'p1', 'config': {}, 'vocabs': []})
    return service


SERVICES_UNDER_TEST = [
    (translate, 'LLMTranslateService', 'The house.'),
    (analyze, 'LLMAnalyzeService', 'house(ev)'),
]


@pytest.mark.parametrize('module, cls, reply', SERVICES_UNDER_TEST)
def test_a_run_stops_after_two_sentences_in_a_row_get_no_answer(module, cls, reply, capsys):
    service = _service(module, cls, [reply, _timeout(), _timeout()] + [reply] * N)
    helper = servicetest.run(service, REQUEST)

    assert service.model.calls == 3
    [result] = helper.results
    failed = result['sentences_failed']
    assert [f['sentence_id'] for f in failed] == ['s2', 's3', 's4', 's5']
    assert all(f['reason'].startswith('model error: The model did not answer')
               for f in failed[:2])
    assert [f['reason'] for f in failed[2:]] == [NOT_ASKED] * 2
    assert 'so the run stopped. 2 sentences were not' in capsys.readouterr().out


@pytest.mark.parametrize('module, cls, reply', SERVICES_UNDER_TEST)
def test_one_silent_sentence_between_answers_does_not_end_the_run(module, cls, reply):
    service = _service(module, cls, [_timeout(), reply, _timeout(), reply, _timeout()])
    helper = servicetest.run(service, REQUEST)

    assert service.model.calls == N
    [result] = helper.results
    assert [f['sentence_id'] for f in result['sentences_failed']] == ['s1', 's3', 's5']
