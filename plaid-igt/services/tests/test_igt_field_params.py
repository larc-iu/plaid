"""A service's field parameters come from the request, never from a name.

The dialog fills a gloss field from the field whose stored Lexicon field is
the entry field gloss (each gloss parameter says so with ``lexicon_field``),
and the field a service writes to, left out, is an error it says, rather than
a field called "Gloss" or "Translation" it assumed. A field read only as
context is left out when none is named."""
import pathlib

import pytest
from plaid_client import testing as servicetest

from test_igt_model_down import REQUEST, _service, analyze, translate

SERVICES = pathlib.Path(__file__).resolve().parent.parent
cwomp = servicetest.load_service(SERVICES / 'igt_analyze_cwomp.py')
polygloss = servicetest.load_service(SERVICES / 'igt_analyze_polygloss.py')


def _params(service):
    return {p['key']: p for p in service.extras['parameters']}


@pytest.mark.parametrize('module, cls', [
    (analyze, 'LLMAnalyzeService'), (translate, 'LLMTranslateService'),
    (polygloss, 'PolyGlossService'), (cwomp, 'CwompService'),
])
def test_no_field_parameter_defaults_to_a_name(module, cls):
    params = _params(getattr(module, cls)())
    for key in ('gloss_field', 'translation_field'):
        assert params[key]['default'] == '', (cls, key)
    assert params['gloss_field']['lexicon_field'] == 'gloss'


def test_an_analysis_without_its_gloss_field_says_so():
    service = _service(analyze, 'LLMAnalyzeService', ['house(ev)'])
    helper = servicetest.run(service, {k: v for k, v in REQUEST.items() if k != 'gloss_field'})
    assert helper.errors == ['Choose the gloss field.']


def test_a_translation_without_its_translation_field_says_so():
    service = _service(translate, 'LLMTranslateService', ['The house.'])
    helper = servicetest.run(service, {k: v for k, v in REQUEST.items() if k != 'translation_field'})
    assert helper.errors == ['Choose the translation field.']
