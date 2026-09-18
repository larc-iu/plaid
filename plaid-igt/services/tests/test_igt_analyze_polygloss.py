"""The PolyGloss analyze service's REQUEST HANDLER, driven end to end.

The model is replaced at its one seam (``service.model``, a predictor with
``describe()`` and ``predict()``), and the document at the client, so a whole
run -- read, derive, predict, plan, lock, write, report -- happens in
milliseconds with no GPU and no server.

Run: pytest plaid-igt/services/tests
"""

import pathlib

from plaid_client import testing as servicetest
from plaid_client.http import PlaidAPIError

SERVICES = pathlib.Path(__file__).resolve().parent.parent

DOC = 'd1'
SOURCE = 'service:polygloss-analyzer'

REQUEST = {
    'document_id': DOC,
    'word_token_layer_id': 'wordL',
    'morpheme_token_layer_id': 'morphL',
    'sentence_token_layer_id': 'sentL',
    'language': 'Turkish',
    'metalanguage': 'English',
    'orthography': '',
    'gloss_field': 'Gloss',
    'translation_field': 'Translation',
    'overwrite': False,
}

OUTPUT = 'house(ev) come(gel)-PROG(iyor)'

polygloss = servicetest.load_service(SERVICES / 'igt_analyze_polygloss.py')


# --- the seam ----------------------------------------------------------------

class _Predictor:
    """Stands in for the loaded ByT5 model. ``answers`` maps the transcription
    it is sent to the ``(text, truncated)`` it replies with."""

    def __init__(self, answers, batches=2):
        self.answers = answers
        self.batches = batches
        self.prompts = []

    def describe(self):
        return {'model': 'polygloss-test'}

    def predict(self, prompts, on_batch=None):
        self.prompts.extend(prompts)
        if on_batch:
            for n in range(1, self.batches + 1):
                on_batch(n, self.batches)
        out = []
        for prompt in prompts:
            transcription = prompt.split('Text in Turkish: ')[1].split('\n')[0]
            out.append(self.answers.get(transcription, ('', False)))
        return out


def _document(*, version=58, morph_meta=None, glosses=None, translation='the house is coming'):
    """One sentence, two words and the punctuation the word layer ignores.
    Both words are unanalyzed unless ``morph_meta`` or ``glosses`` (each keyed
    by morpheme id) puts something on them."""
    morph_meta = morph_meta or {}
    glosses = glosses or {}
    morphs = [
        {'id': 'm1', 'text': 't', 'begin': 0, 'end': 2, 'precedence': 1,
         'metadata': dict(morph_meta.get('m1', {}))},
        {'id': 'm2', 'text': 't', 'begin': 3, 'end': 10, 'precedence': 1,
         'metadata': dict(morph_meta.get('m2', {}))},
    ]
    gloss_spans = [{'id': f'g-{mid}', 'tokens': [mid], 'value': value, 'metadata': meta}
                   for mid, (value, meta) in sorted(glosses.items())]
    return {
        'id': DOC,
        'version': version,
        'text_layers': [{
            'id': 'textL',
            'text': {'id': 't', 'body': 'ev geliyor .'},
            'token_layers': [
                {'id': 'sentL', 'name': 'Sentences',
                 'tokens': [{'id': 's1', 'begin': 0, 'end': 12}],
                 'span_layers': [{'id': 'trL', 'name': 'Translation',
                                  'config': {'igt': {'scope': 'Sentence'}},
                                  'spans': [{'id': 'tr1', 'tokens': ['s1'],
                                             'value': translation}]}],
                 'vocabs': []},
                {'id': 'wordL', 'name': 'Words',
                 'config': {'igt': {'ignoredTokens': {'type': 'unicodePunctuation',
                                                     'whitelist': []}}},
                 'tokens': [{'id': 'w1', 'text': 't', 'begin': 0, 'end': 2, 'metadata': {}},
                            {'id': 'w2', 'text': 't', 'begin': 3, 'end': 10, 'metadata': {}},
                            {'id': 'w3', 'text': 't', 'begin': 11, 'end': 12, 'metadata': {}}],
                 'span_layers': [], 'vocabs': []},
                {'id': 'morphL', 'name': 'Morphemes', 'tokens': morphs,
                 'span_layers': [{'id': 'glossL', 'name': 'Gloss',
                                  'config': {'igt': {'scope': 'Morpheme'}},
                                  'spans': gloss_spans}],
                 'vocabs': []},
            ],
        }],
    }


def _service(*, documents=None, answers=None, fails=None, batches=2):
    service = polygloss.PolyGlossService()
    if answers is None:
        answers = {'ev geliyor': (OUTPUT, False)}
    service.model = _Predictor(answers, batches=batches)
    service.client = servicetest.FakeClient(documents or [_document()], fails=fails)
    return service


# --- the happy path ----------------------------------------------------------

def test_an_analysis_lands_stamped_machine_made_and_never_confirmed():
    service = _service()
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == []
    [result] = helper.results
    assert result['status'] == 'success'
    assert result['sentences'] == 1 and result['sentences_sent'] == 1
    assert result['words_written'] == 2 and result['words_replaced'] == 0
    assert result['skipped'] == {'protected': 0, 'no_morpheme': 0, 'unaligned': 0}
    assert result['sentences_failed'] == []
    assert result['translation_field_missing'] is None
    assert 'stopped' not in result

    # The prompt carried the words, the translation and both language names.
    [prompt] = service.model.prompts
    assert 'Text in Turkish: ev geliyor' in prompt
    assert 'Translation in English: the house is coming' in prompt

    # Each word's first morpheme is patched in place and further slots created.
    patched = dict(payload for kind, payload in service.client.calls
                   if kind == 'tokens.patch_metadata')
    assert set(patched) == {'m1', 'm2'}
    assert patched['m1']['form'] == 'ev' and patched['m2']['form'] == 'gel'
    for meta in patched.values():
        assert meta['prov'] == 'inferred' and meta['provSource'] == SOURCE
        assert 'provConfirmed' not in meta
        assert 'provProb' not in meta          # PolyGloss exposes no probabilities
        assert meta['provDetail']['model'] == 'polygloss-test'
        assert meta['provDetail']['language'] == 'Turkish'
    assert patched['m1']['provDetail']['form'] == 'ev'
    assert patched['m2']['provDetail']['boundaries'] == '-'

    created = [c['args'] for kind, c in service.client.calls if kind == 'tokens.create']
    assert [args[0] for args in created] == ['morphL']
    [(_, _, begin, end)] = [args for args in created]
    assert (begin, end) == (3, 10)             # the new slot covers its word

    # …and every morpheme gets its gloss, stamped with what was predicted.
    glosses = [(call['args'][1], call['args'][2], call['args'][3])
               for kind, call in service.client.calls if kind == 'spans.create']
    assert [value for _, value, _ in glosses] == ['house', 'come', 'PROG']
    for _, value, meta in glosses:
        assert meta['prov'] == 'inferred' and meta['provSource'] == SOURCE
        assert 'provConfirmed' not in meta
        assert meta['provDetail']['value'] == value

    assert service.client.operations == ['PolyGloss analysis (2 words)']


def test_a_word_a_person_analyzed_is_left_alone_and_counted():
    # A human gloss on the second word's morpheme protects that whole word.
    service = _service(documents=[_document(glosses={'m2': ('come', {})})])
    helper = servicetest.run(service, REQUEST)

    [result] = helper.results
    assert result['skipped']['protected'] == 1
    assert result['words_written'] == 1
    patched = [payload[0] for kind, payload in service.client.calls
               if kind == 'tokens.patch_metadata']
    assert patched == ['m1']
    assert 'g-m2' not in [payload for kind, payload in service.client.calls
                          if kind == 'spans.delete']


def test_a_words_machine_analysis_is_replaced_and_counted():
    machine = {'prov': 'inferred', 'provSource': 'service:other'}
    service = _service(documents=[_document(glosses={'m2': ('come', machine)})])
    helper = servicetest.run(service, REQUEST)

    [result] = helper.results
    assert result['skipped']['protected'] == 0
    assert result['words_written'] == 2 and result['words_replaced'] == 1
    # The gloss it replaces is deleted first, so nothing is doubled up.
    assert 'g-m2' in [payload for kind, payload in service.client.calls
                      if kind == 'spans.delete']


def test_a_document_with_nothing_left_to_do_says_so_without_taking_the_lock():
    # Both words carry human work, so there is no target at all.
    both = _document(glosses={'m1': ('house', {}), 'm2': ('come', {})})
    service = _service(documents=[both])
    helper = servicetest.run(service, REQUEST)

    [result] = helper.results
    assert result['words_written'] == 0
    assert result['message'] == 'Nothing to analyze: every word is already analyzed by a person.'
    assert service.client.writes == []
    assert 'lock' not in service.client.kinds
    assert service.model.prompts == [], 'the model was not even asked'


# --- the lock and the version check ------------------------------------------

def test_the_lock_is_taken_before_the_writes_and_released_after_them():
    service = _service()
    servicetest.run(service, REQUEST)
    kinds = service.client.kinds
    assert kinds.count('lock') == 1 and kinds.count('unlock') == 1
    writes = [i for i, k in enumerate(kinds) if k.startswith(('tokens.', 'spans.'))]
    assert kinds.index('lock') < min(writes)
    assert kinds.index('unlock') > max(writes)


def test_the_lock_is_released_when_a_write_fails():
    service = _service(fails={'spans.create': PlaidAPIError(
        'HTTP 400 Span value is required at http://plaid.internal:8085/api/v1/spans',
        status=400, url='http://plaid.internal:8085/api/v1/spans', method='POST')})
    helper = servicetest.run(service, REQUEST)

    assert service.client.kinds[-1] == 'unlock'
    assert service.client.writes == []         # the batch aborted before submit
    assert len(helper.errors) == 1


def test_a_document_that_moved_while_the_model_ran_is_not_written_to():
    """The plans were made from a read taken before the model ran. If someone
    edited the document since, both the write contract the words were selected
    under and the ids the plans point at are out of date."""
    service = _service(documents=[_document(version=58), _document(version=59)])
    helper = servicetest.run(service, REQUEST)

    assert helper.reports == [
        ('error', 'The document changed while this run was working. Run it again.')]
    assert service.client.writes == []
    # It is checked under the lock and the lock is handed back.
    assert service.client.kinds.count('lock') == 1
    assert service.client.kinds[-1] == 'unlock'


def test_a_document_that_stood_still_is_written_to():
    service = _service(documents=[_document(version=58), _document(version=58)])
    helper = servicetest.run(service, REQUEST)
    assert helper.errors == []
    assert helper.results[0]['words_written'] == 2


# --- refusals ----------------------------------------------------------------

def test_a_gloss_field_by_that_name_is_refused_once_in_its_own_words():
    service = _service()
    helper = servicetest.run(service, {**REQUEST, 'gloss_field': 'Nope'})

    assert len(helper.reports) == 1
    kind, text = helper.reports[0]
    assert kind == 'error'
    assert text.startswith('No morpheme-scope field named "Nope"')
    assert 'Gloss' in text                     # it names what is there instead
    assert service.client.writes == []


def test_a_translation_field_that_is_not_there_is_named_and_the_run_goes_on():
    # Context only: glosses still land, and the result says what was missing
    # rather than analyzing without the translation in silence.
    service = _service()
    helper = servicetest.run(service, {**REQUEST, 'translation_field': 'Translation (en)'})

    assert helper.errors == []
    [result] = helper.results
    assert result['translation_field_missing'] == 'Translation (en)'
    assert result['words_written'] == 2
    [prompt] = service.model.prompts
    assert 'the house is coming' not in prompt


def test_a_missing_option_is_reported_once_and_nothing_is_read():
    service = _service()
    helper = servicetest.run(service, {**REQUEST, 'language': '  '})
    assert helper.reports == [('error', 'Missing required option: Language')]
    assert service.client.calls == []


def test_a_missing_parameter_is_reported_once_and_nothing_is_read():
    service = _service()
    helper = servicetest.run(service, {**REQUEST, 'morpheme_token_layer_id': None})
    assert helper.reports == [('error', 'Missing required parameter: morphemeTokenLayerId')]
    assert service.client.calls == []


def test_a_failure_reaches_the_requester_once_without_an_internal_url():
    service = _service(fails={'tokens.patch_metadata': PlaidAPIError(
        'HTTP 409 Version conflict at http://plaid.internal:8085/api/v1/tokens/m1/metadata',
        status=409, url='http://plaid.internal:8085/api/v1/tokens/m1/metadata',
        method='PATCH')})
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == ['PolyGloss: HTTP 409 Version conflict']
    assert 'plaid.internal' not in helper.errors[0] and 'http' not in helper.errors[0]


def test_a_sentence_the_model_could_not_answer_is_reported_not_raised():
    """A per-sentence failure rides in ``sentences_failed``; the request still
    succeeds, and a caller that reads only the counts will announce a document
    nothing was written to."""
    service = _service(answers={})            # empty output for every sentence
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == []
    [result] = helper.results
    assert result['status'] == 'success'
    assert result['words_written'] == 0
    assert result['sentences_failed'] == [{'sentence_id': 's1', 'reason': 'empty output'}]
    assert result['skipped']['unaligned'] == 2
    assert service.client.writes == []


# --- progress through the long stretches -------------------------------------

def test_the_model_and_the_writing_both_say_how_far_in_they_are():
    service = _service(batches=4)
    helper = servicetest.run(service, REQUEST)

    analyzing = [(pct, msg) for pct, msg in helper.beats if msg.startswith('Analyzing')]
    assert [msg for _, msg in analyzing] == [
        f'Analyzing sentences ({n}/4 batches)...' for n in (1, 2, 3, 4)]
    assert [pct for pct, _ in analyzing] == [31, 47, 63, 80]

    writing = [(pct, msg) for pct, msg in helper.beats if msg.startswith('Writing analyses (')]
    assert writing == [(88, 'Writing analyses (0/1 batches)...'),
                       (99, 'Writing analyses (1/1 batches)...')]
    assert helper.beats[-1] == (100, 'Done')


# --- stopping ----------------------------------------------------------------

def test_a_stop_while_the_model_runs_ends_the_run_with_one_report():
    service = _service(batches=4)
    helper = servicetest.Helper(
        stop_when=lambda pct, msg: msg == 'Analyzing sentences (1/4 batches)...')
    servicetest.run(service, REQUEST, helper)

    assert helper.reports == [('completed', {'stopped': True})]
    assert service.client.writes == []
    assert 'lock' not in service.client.kinds


def test_a_stop_before_the_writes_ends_the_run_with_one_report():
    service = _service()
    helper = servicetest.Helper(stop_when=lambda pct, msg: msg == 'Fetching document...')
    servicetest.run(service, REQUEST, helper)

    assert helper.reports == [('completed', {'stopped': True})]
    assert service.client.writes == []


def test_a_stop_that_lands_in_the_writes_is_ignored_and_the_run_finishes():
    """Luke's ruling: a stop with nothing left to prevent is silently ignored.
    The lock, the version check, every write and the final report sit in one
    critical block, so stopping half-way through a word's morpheme chain
    finishes it rather than leaving the document worse than either outcome."""
    service = _service()
    helper = servicetest.Helper(stop_when=lambda pct, msg: msg == 'Writing analyses...')
    servicetest.run(service, REQUEST, helper)

    assert helper.cancelled, 'the stop never landed, so this proves nothing'
    [result] = helper.results
    assert result['status'] == 'success' and 'stopped' not in result
    assert result['words_written'] == 2
    assert service.client.kinds[-1] == 'unlock'
