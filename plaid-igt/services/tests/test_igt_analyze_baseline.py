"""Both analyze services send the baseline and write morphemes in it, also on
a project with another orthography line (Luke's ruling, 2026-10-03). A run
with Orthography set sent that line to the model and wrote its segments as
the morphemes' forms, so the morpheme row came out in another script than
the word row above it (H26-SERVICES-5). Neither service takes the option
any more, and a request that still carries it is read as if it did not.

Run: pytest plaid-igt/services/tests"""

import pathlib

import pytest
from plaid_client import apply_metadata_ops
from plaid_client import testing as servicetest
from plaid_client.workflows.llm import Reply

SERVICES = pathlib.Path(__file__).resolve().parent.parent
polygloss = servicetest.load_service(SERVICES / 'igt_analyze_polygloss.py')
llm = servicetest.load_service(SERVICES / 'igt_analyze_llm.py')

BASELINE = 'house(ev) come(gel)-PROG(iyor)'
TRANSLIT = 'house(EV) come(GEL)-PROG(IYOR)'


def _document():
    """`ev geliyor .` with a Translit line on both words, nothing analyzed."""
    def word(wid, begin, end, translit):
        return {'id': wid, 'text': 't', 'begin': begin, 'end': end,
                'metadata': {'orthog:Translit': translit} if translit else {}}
    return {'id': 'd1', 'version': 3, 'text_layers': [{
        'id': 'textL', 'text': {'id': 't', 'body': 'ev geliyor .'},
        'token_layers': [
            {'id': 'sentL', 'tokens': [{'id': 's1', 'begin': 0, 'end': 12}],
             'span_layers': [{'id': 'trL', 'name': 'Translation', 'config': {'igt': {'scope': 'Sentence'}},
                              'spans': [{'id': 'tr1', 'tokens': ['s1'], 'value': 'the house is coming'}]}],
             'vocabs': []},
            {'id': 'wordL',
             'config': {'igt': {'ignoredTokens': {'type': 'unicodePunctuation', 'whitelist': []}}},
             'tokens': [word('w1', 0, 2, 'EV'), word('w2', 3, 10, 'GELIYOR'), word('w3', 11, 12, None)],
             'span_layers': [], 'vocabs': []},
            {'id': 'morphL',
             'tokens': [{'id': 'm1', 'text': 't', 'begin': 0, 'end': 2, 'precedence': 1, 'metadata': {}},
                        {'id': 'm2', 'text': 't', 'begin': 3, 'end': 10, 'precedence': 1, 'metadata': {}}],
             'span_layers': [{'id': 'glossL', 'name': 'Gloss', 'config': {'igt': {'scope': 'Morpheme'}},
                              'spans': []}],
             'vocabs': []},
        ]}]}


# A request as an older dialog sent it, the orthography still in it.
REQUEST = {'document_id': 'd1', 'project_id': 'p1', 'word_token_layer_id': 'wordL',
           'morpheme_token_layer_id': 'morphL', 'sentence_token_layer_id': 'sentL',
           'language': 'Turkish', 'metalanguage': 'English', 'gloss_field': 'Gloss',
           'translation_field': 'Translation', 'orthography': 'Translit', 'examples': 0,
           'overwrite': False}


class _PolyGloss:
    """Answers in the script it was sent."""

    def __init__(self):
        self.prompts = []

    def describe(self):
        return {'model': 'polygloss-test'}

    def predict(self, prompts, on_batch=None):
        self.prompts.extend(prompts)
        return [((TRANSLIT if 'EV' in p else BASELINE), False) for p in prompts]


class _Chat:
    """Answers in the script it was sent."""

    def __init__(self):
        self.prompts = []

    def complete(self, system, user, should_stop=None):
        self.prompts.append(user)
        return Reply(text=TRANSLIT if 'EV' in user else BASELINE)

    def describe(self):
        return {'model': 'fake/m'}

    def usage_line(self):
        return 'fake/m'


def _polygloss():
    service = polygloss.PolyGlossService()
    service.model = _PolyGloss()
    return service


def _llm():
    service = llm.LLMAnalyzeService()
    service.model = _Chat()
    service.REQUEST_SECRETS = ()
    return service


@pytest.mark.parametrize('make', [_polygloss, _llm], ids=['polygloss', 'llm'])
def test_the_model_reads_the_baseline_and_the_morphemes_are_written_in_it(make):
    service = make()
    assert 'orthography' not in [p['key'] for p in service.extras['parameters']]
    service.client = servicetest.FakeClient([_document()],
                                            project={'id': 'p1', 'config': {}, 'vocabs': []})
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == []
    [result] = helper.results
    assert result['status'] == 'success' and result['words_written'] == 2
    [prompt] = service.model.prompts
    assert 'ev geliyor' in prompt and 'EV' not in prompt

    patched = {payload[0]: apply_metadata_ops({}, payload[1])
               for kind, payload in service.client.calls if kind == 'tokens.patch_metadata'}
    assert patched['m1']['form'] == 'ev' and patched['m2']['form'] == 'gel'
    created = [c['kwargs']['metadata']['form'] for kind, c in service.client.calls
               if kind == 'tokens.create']
    assert created == ['iyor']
