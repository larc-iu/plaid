"""A service reads its declared parameters as BaseService coerced them against
the schema, the app's dialog's coercion (R2-SVC-2): a value left out takes the
schema's default, a number is clamped, and 0 is a number, not a missing one."""

import pytest
from plaid_client import testing as servicetest

from test_igt_model_down import REQUEST, _service, analyze, translate


def _recording(monkeypatch, module, name):
    """Calls of ``module.name``, which still runs."""
    calls = []
    real = getattr(module, name)

    def record(*args, **kwargs):
        calls.append((args, kwargs))
        return real(*args, **kwargs)
    monkeypatch.setattr(module, name, record)
    return calls


@pytest.mark.parametrize('examples, reads', [(0, 0), (None, 1), (-3, 0)])
def test_the_analyzer_reads_no_examples_when_asked_for_none(monkeypatch, examples, reads):
    calls = _recording(monkeypatch, analyze, 'load_examples')
    service = _service(analyze, 'LLMAnalyzeService', ['house(ev)'] * 5)
    request = {**REQUEST, 'examples': examples} if examples is not None else dict(REQUEST)
    helper = servicetest.run(service, request)
    assert helper.errors == []
    assert len(calls) == reads


def test_the_translator_shows_the_declared_context_when_none_is_asked(monkeypatch):
    calls = _recording(monkeypatch, translate, 'build_user_prompt')
    service = _service(translate, 'LLMTranslateService', ['The house.'] * 5)
    helper = servicetest.run(service, REQUEST)
    assert helper.errors == []
    assert [len(args[4]) for args, _ in calls] == [0, 1, 2, 2, 2]


@pytest.mark.parametrize('module, cls, reply', [
    (translate, 'LLMTranslateService', 'The house.'), (analyze, 'LLMAnalyzeService', 'house(ev)')])
def test_a_blank_metalanguage_is_the_declared_one(monkeypatch, module, cls, reply):
    calls = _recording(monkeypatch, module, 'build_user_prompt')
    service = _service(module, cls, [reply] * 5)
    helper = servicetest.run(service, {**REQUEST, 'metalanguage': '  '})
    assert helper.errors == []
    assert {args[1] for args, _ in calls} == {'English'}


def test_a_gloss_field_the_document_lacks_is_translated_without_glosses():
    """R2-SVC-4: the translator goes on without glosses when derive refuses
    the gloss field (NoGlossField), whatever the refusal's words, and says so."""
    service = _service(translate, 'LLMTranslateService', ['The house.'] * 5)
    helper = servicetest.run(service, {**REQUEST, 'use_glosses': True, 'gloss_field': 'Nope'})
    assert helper.errors == []
    [result] = helper.results
    assert result['gloss_field_missing'] == 'Nope' and result['sentences_written'] == 5


def test_the_translator_reads_each_sentences_translation_span_from_derive():
    from plaid_client.workflows.igt import derive
    from test_igt_model_down import _document
    doc = _document()
    trl = doc['text_layers'][0]['token_layers'][0]['span_layers'][0]
    trl['spans'] = [{'id': 'sp1', 'tokens': ['s2'], 'value': 'the water'}]
    sentences, _ = derive(doc, 'wordL', 'morphL', 'sentL', gloss_field=None, translation_field='Translation')
    assert [s['translation_span'] and s['translation_span']['id'] for s in sentences] == [
        None, 'sp1', None, None, None]
    assert sentences[1]['translation'] == 'the water'


def test_a_translation_is_replaced_by_path_ops_in_one_bulk_update_and_new_ones_in_one_bulk_create():
    """R4-3-5: the translator replaced a stored translation's whole metadata
    with a PUT, one sentence at a time, dropping any other key on the span. It
    now patches the provenance keys only, in one bulk update, and creates the
    new ones in one bulk create."""
    from test_igt_model_down import _document
    doc = _document()
    trl = doc['text_layers'][0]['token_layers'][0]['span_layers'][0]
    trl['spans'] = [
        {'id': 'sp1', 'tokens': ['s1'], 'value': 'old guess',
         'metadata': {'prov': 'inferred', 'provSource': 'service:x', 'provProb': 0.4,
                      'other': {'kept': True}}},
        {'id': 'sp2', 'tokens': ['s2'], 'value': 'a person wrote this',
         'metadata': {'prov': 'inferred', 'provSource': 'service:x', 'provConfirmed': True,
                      'note': 'kept'}},
    ]
    service = _service(translate, 'LLMTranslateService', ['The house.'] * 5)
    service.client = servicetest.FakeClient([doc], project={'id': 'p1', 'config': {}, 'vocabs': []})
    helper = servicetest.run(service, {**REQUEST, 'overwrite': True})
    assert helper.errors == []
    [result] = helper.results
    assert result['sentences_written'] == 5 and result['sentences_replaced'] == 2

    kinds = service.client.kinds
    assert 'spans.set_metadata' not in kinds
    assert 'spans.update' not in kinds and 'spans.create' not in kinds
    [updates] = service.client.payloads('spans.bulk_update')
    by_id = {u['id']: u for u in updates}
    assert set(by_id) == {'sp1', 'sp2'}
    assert all(u['value'] == 'The house.' for u in updates)
    after = {i: servicetest.as_fragment(u['metadata']) for i, u in by_id.items()}
    for frag in after.values():
        assert frag['prov'] == 'inferred'
        assert frag['provSource'].startswith('service:') and 'provDetail' in frag
    # Only provenance keys are named, and a key the new stamp lacks goes.
    assert after['sp1']['provProb'] is None and 'other' not in after['sp1']
    assert after['sp2']['provConfirmed'] is None and 'note' not in after['sp2']
    [creates] = service.client.payloads('spans.bulk_create')
    assert sorted(c['tokens'][0] for c in creates) == ['s3', 's4', 's5']
    assert all(c['span_layer_id'] == 'trL' and c['value'] == 'The house.' for c in creates)
