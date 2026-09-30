"""The Stanza parser's REQUEST HANDLER, driven end to end.

Stanza is replaced at its two seams -- the module the service imports for its
version string, and ``self.pipeline_provider``, whose ``get()`` returns the
pipeline -- and the document at the client. So a whole run (read, resolve the
substrate, parse, write the tokens, spans and relations, report) happens in
milliseconds with no models, no download and no server.

Run: pytest services/tests, from plaid-ud. Runs from the base env; stanza
itself is never imported.
"""

import json
import pathlib
import types

import pytest
from plaid_client import testing as servicetest
from plaid_client.http import PlaidAPIError
from plaid_client.service import service_version
from plaid_client.workflows.messages import SETUP_INCOMPLETE

SERVICES = pathlib.Path(__file__).resolve().parent.parent

DOC = 'd1'
BODY = 'the dog barks'
SOURCE = 'service:stanza-parser'

REQUEST = {'document_id': DOC, 'language': 'en', 'overwrite': False}

#: What Stanza's ``to_dict()`` gives for BODY: three syntactic words, one tree.
ROWS = [
    {'id': 1, 'text': 'the', 'lemma': 'the', 'upos': 'DET', 'xpos': 'DT',
     'feats': 'Definite=Def|PronType=Art', 'head': 2, 'deprel': 'det',
     'start_char': 0, 'end_char': 3},
    {'id': 2, 'text': 'dog', 'lemma': 'dog', 'upos': 'NOUN', 'xpos': 'NN',
     'feats': 'Number=Sing', 'head': 3, 'deprel': 'nsubj',
     'start_char': 4, 'end_char': 7},
    {'id': 3, 'text': 'barks', 'lemma': 'bark', 'upos': 'VERB', 'xpos': 'VBZ',
     'feats': 'Number=Sing|Person=3', 'head': 0, 'deprel': 'root',
     'start_char': 8, 'end_char': 13},
]


# --- the seams ---------------------------------------------------------------

fake_stanza = types.ModuleType('stanza')
fake_stanza.__version__ = '1.11.0'
fake_stanza.Pipeline = lambda *a, **k: (_ for _ in ()).throw(
    AssertionError('a test must not build a real pipeline'))

ud = servicetest.load_service(SERVICES / 'ud_parse_stanza.py', {'stanza': fake_stanza})


class _Token:
    def __init__(self, start_char):
        self.start_char = start_char


class _Sentence:
    def __init__(self, text, start_char):
        self.text = text
        self.tokens = [_Token(start_char)]


class _Parsed:
    def __init__(self, sentences_data, sentence_starts=None):
        self._data = sentences_data
        self.sentences = [_Sentence(' '.join(r['text'] for r in rows if not isinstance(r['id'], tuple)),
                                    start)
                          for rows, start in zip(sentences_data, sentence_starts or [0])]

    def to_dict(self):
        return self._data


class _PipelineProvider:
    """Stands in for the real provider: records which pipelines were asked for
    and replies with a fixed parse."""

    def __init__(self, sentences_data=None, sentence_starts=None, on_parse=None):
        self.asked = []
        self.inputs = []
        self._data = sentences_data if sentences_data is not None else [ROWS]
        self._starts = sentence_starts or [0]
        self._on_parse = on_parse

    def get(self, language, pretokenized=False):
        self.asked.append((language, pretokenized))

        def pipeline(value):
            self.inputs.append(value)
            if self._on_parse:
                self._on_parse()
            return _Parsed(self._data, self._starts)

        return pipeline


def _layer(layer_id, name, role=None, **extra):
    layer = {'id': layer_id, 'name': name, 'tokens': [], **extra}
    if role:
        layer['config'] = {'plaid': {'role': role}}
    return layer


def _document(*, body=BODY, sentences=(), words=(), morphemes=(),
              spans=None, relations=(), enhanced_relations=(), links=()):
    """A UD document: a baseline text layer with the three role-tagged token
    layers, and the five UD annotation span layers on the syntactic words."""
    spans = spans or {}
    span_layer_ids = [('formL', 'Form', 'form'), ('lemmaL', 'Lemma', 'lemma'),
                      ('uposL', 'UPOS', 'upos'), ('xposL', 'XPOS', 'xpos'),
                      ('featsL', 'Features', 'features')]
    span_layers = []
    for layer_id, name, key in span_layer_ids:
        layer = {'id': layer_id, 'name': name, 'config': {'ud': {key: True}},
                 'spans': list(spans.get(layer_id, []))}
        if key == 'lemma':
            layer['relation_layers'] = [
                {'id': 'depL', 'name': 'Dependencies',
                 'config': {'ud': {'dependency': True}},
                 'relations': list(relations)},
                {'id': 'edepL', 'name': 'Enhanced Dependencies',
                 'config': {'ud': {'enhancedDependency': True}},
                 'relations': list(enhanced_relations)}]
        span_layers.append(layer)
    return {
        'id': DOC,
        'version': 58,
        'text_layers': [{
            'id': 'textL', 'name': 'Baseline',
            'config': {'plaid': {'role': 'baseline'}},
            'text': {'id': 'text-1', 'body': body},
            'token_layers': [
                _layer('sentL', 'Sentences', 'sentence',
                       tokens=[{'id': f's{i}', 'begin': b, 'end': e}
                               for i, (b, e) in enumerate(sentences)]),
                _layer('wordL', 'Words', 'word',
                       tokens=[{'id': f'w{i}', 'begin': b, 'end': e}
                               for i, (b, e) in enumerate(words)]),
                _layer('morphL', 'Morphemes', 'syntactic-word',
                       tokens=[{'id': mid, 'begin': b, 'end': e}
                               for mid, b, e in morphemes],
                       span_layers=span_layers,
                       vocabs=[{'id': 'v1', 'vocab_links': list(links)}]),
            ],
        }],
    }


def _service(*, documents=None, fails=None, provider=None, limits=None):
    service = ud.StanzaParserService()
    service.pipeline_provider = provider or _PipelineProvider()
    service.client = servicetest.FakeClient(documents or [_document()], fails=fails,
                                            limits=limits)
    return service


def _ops(client, kind, layer_key, layer_id):
    return [op for payload in client.payloads(kind) for op in payload
            if op.get(layer_key) == layer_id]


# --- the happy path ----------------------------------------------------------

def test_a_parse_lands_stamped_machine_made_and_never_confirmed():
    service = _service()
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == []
    [result] = helper.results
    assert result['status'] == 'success'
    assert result['mode'] == 'full'
    assert result['parsed_sentences'] == 1 and result['skipped_sentences'] == 0
    assert result['notice'] == {'level': 'success', 'title': 'Parsed 1 sentence',
                                'message': ''}
    assert 'stopped' not in result

    # The whole hierarchy, top down, in one batch.
    assert [op['begin'] for op in _ops(service.client, 'tokens.bulk_create',
                                       'token_layer_id', 'sentL')] == [0]
    words = _ops(service.client, 'tokens.bulk_create', 'token_layer_id', 'wordL')
    assert [(op['begin'], op['end']) for op in words] == [(0, 3), (4, 7), (8, 13)]
    morphemes = _ops(service.client, 'tokens.bulk_create', 'token_layer_id', 'morphL')
    assert [op['precedence'] for op in morphemes] == [0, 0, 0]

    # Sentence and word tokens are substrate and carry no stamp: the sentence
    # keeps only the text Stanza recovered, and a 1:1 word no metadata at all.
    [sentence] = _ops(service.client, 'tokens.bulk_create', 'token_layer_id', 'sentL')
    assert sentence['metadata'] == {'text': 'the dog barks'}
    assert [op.get('metadata') for op in words] == [None, None, None]
    # What made them is named by the run's operation instead.
    assert service.client.operation_tags == [{'kind': 'service-run', 'ref': SOURCE}]

    # Every syntactic word, span and relation carries the machine stamp and
    # nothing else.
    written = (morphemes
               + [op for kind in ('lemmaL', 'uposL', 'xposL', 'featsL')
                  for op in _ops(service.client, 'spans.bulk_create', 'span_layer_id', kind)]
               + [op for payload in service.client.payloads('relations.bulk_create')
                  for op in payload])
    assert written, 'nothing was written'
    for op in written:
        meta = op['metadata']
        assert meta['prov'] == 'inferred'
        assert meta['provSource'] == SOURCE
        assert 'provConfirmed' not in meta
        assert 'provProb' not in meta          # Stanza exposes no probabilities
        assert meta['provDetail'] == {'model': 'stanza==1.11.0', 'language': 'en',
                                      'version': service_version(ud.__file__)}

    # The UD columns each land in their own layer; Form only where the surface
    # differs from the body slice, which it never does for a 1:1 tokenization.
    assert _ops(service.client, 'spans.bulk_create', 'span_layer_id', 'formL') == []
    lemmas = _ops(service.client, 'spans.bulk_create', 'span_layer_id', 'lemmaL')
    assert [op['value'] for op in lemmas] == ['the', 'dog', 'bark']
    assert [op['value'] for op in
            _ops(service.client, 'spans.bulk_create', 'span_layer_id', 'uposL')] == \
        ['DET', 'NOUN', 'VERB']
    assert [op['value'] for op in
            _ops(service.client, 'spans.bulk_create', 'span_layer_id', 'featsL')] == \
        ['Definite=Def', 'PronType=Art', 'Number=Sing', 'Number=Sing', 'Person=3']

    # The tree hangs off the lemma spans, and the root points at itself.
    [rels] = service.client.payloads('relations.bulk_create')
    by_value = {r['value']: (r['source'], r['target']) for r in rels}
    assert set(by_value) == {'det', 'nsubj', 'root'}
    assert by_value['root'][0] == by_value['root'][1]
    assert by_value['det'][0] == by_value['nsubj'][1]   # the noun heads the det

    assert service.client.operations == ['Stanza UD parse (en)']
    assert service.pipeline_provider.asked == [('en', False)]
    assert service.pipeline_provider.inputs == [BODY]


def test_a_multiword_token_keeps_its_surface_form_and_no_stamp():
    """A multi-word token's word carries the round-trip data (its form and
    misc) but, being substrate, no provenance. Its syntactic words are
    stamped."""
    body = 'del perro'
    rows = [
        {'id': (1, 2), 'text': 'del', 'misc': 'SpaceAfter=Yes',
         'start_char': 0, 'end_char': 3},
        {'id': 1, 'text': 'de', 'lemma': 'de', 'upos': 'ADP', 'head': 3, 'deprel': 'case'},
        {'id': 2, 'text': 'el', 'lemma': 'el', 'upos': 'DET', 'head': 3, 'deprel': 'det'},
        {'id': 3, 'text': 'perro', 'lemma': 'perro', 'upos': 'NOUN', 'head': 0,
         'deprel': 'root', 'start_char': 4, 'end_char': 9},
    ]
    service = _service(documents=[_document(body=body)],
                       provider=_PipelineProvider([rows]))
    helper = servicetest.run(service, {**REQUEST, 'language': 'es'})
    assert helper.errors == []

    words = _ops(service.client, 'tokens.bulk_create', 'token_layer_id', 'wordL')
    assert [(op['begin'], op['end']) for op in words] == [(0, 3), (4, 9)]
    assert words[0]['metadata'] == {'misc': 'SpaceAfter=Yes'}
    assert 'metadata' not in words[1]

    morphemes = _ops(service.client, 'tokens.bulk_create', 'token_layer_id', 'morphL')
    assert [(op['begin'], op['end'], op['precedence']) for op in morphemes] == \
        [(0, 3, 0), (0, 3, 1), (4, 9, 0)]
    for op in morphemes:
        assert op['metadata']['prov'] == 'inferred'
        assert op['metadata']['provSource'] == SOURCE


def test_the_parse_names_who_asked_in_history_and_on_what_it_writes():
    """umr-collab-service-requester, in every app: the service writes with
    its operator's token, so the requester core sent is named in the History
    label and in each stamp's provDetail."""
    service = _service()
    service.client.users = types.SimpleNamespace(
        get=lambda uid: {'id': uid, 'display_name': 'second'})
    servicetest.run(service, {**REQUEST, 'requester_id': 'second@x.com'})

    assert service.client.operations == ['Stanza UD parse (en), requested by second']
    written = [op for payload in service.client.payloads('relations.bulk_create')
               for op in payload]
    assert written
    for op in written:
        assert op['metadata']['provDetail']['requestedBy'] == 'second@x.com'


def test_an_already_tokenized_document_keeps_its_substrate():
    """The shared-project path: sentences and words already exist, so only the
    syntactic-word subtree is replaced and Stanza runs pretokenized."""
    doc = _document(sentences=[(0, 13)], words=[(0, 3), (4, 7), (8, 13)],
                    morphemes=[('m0', 0, 3), ('m1', 4, 7), ('m2', 8, 13)])
    service = _service(documents=[doc])
    helper = servicetest.run(service, REQUEST)

    [result] = helper.results
    assert result['mode'] == 'preserve'
    assert result['parsed_sentences'] == 1 and result['skipped_sentences'] == 0
    assert service.pipeline_provider.asked == [('en', True)]
    assert service.pipeline_provider.inputs == [[['the', 'dog', 'barks']]]

    # The old syntactic words go, the substrate stays.
    assert service.client.payloads('tokens.bulk_delete') == [['m0', 'm1', 'm2']]
    # The whole write is one atomic batch (conc-2026-09-29 V8-S2): a delete
    # sent alone, then a failed batch, left the document with no words, and
    # spans in a batch of their own left words with no annotation.
    [batch] = service.client.batches
    kinds = [kind for kind, _ in batch]
    assert kinds[:2] == ['tokens.bulk_delete', 'tokens.bulk_create']
    assert set(kinds[2:]) <= {'spans.bulk_create', 'relations.bulk_create'} and len(kinds) > 2
    # A span names its morpheme by a ref to the id the create makes.
    spans = [e for kind, p in batch if kind == 'spans.bulk_create' for e in p]
    assert spans[0]['tokens'] == [{'$ref': 1, 'index': 0}]
    assert _ops(service.client, 'tokens.bulk_create', 'token_layer_id', 'sentL') == []
    assert _ops(service.client, 'tokens.bulk_create', 'token_layer_id', 'wordL') == []
    morphemes = _ops(service.client, 'tokens.bulk_create', 'token_layer_id', 'morphL')
    assert len(morphemes) == 3
    for op in morphemes:
        assert op['metadata']['prov'] == 'inferred'
        assert op['metadata']['provSource'] == SOURCE


def test_a_sentence_a_person_annotated_is_left_untouched():
    human_lemma = {'id': 'sp1', 'tokens': ['m0'], 'value': 'the', 'metadata': {}}
    doc = _document(sentences=[(0, 13)], words=[(0, 3), (4, 7), (8, 13)],
                    morphemes=[('m0', 0, 3), ('m1', 4, 7), ('m2', 8, 13)],
                    spans={'lemmaL': [human_lemma]})
    service = _service(documents=[doc])
    helper = servicetest.run(service, REQUEST)

    [result] = helper.results
    assert result['parsed_sentences'] == 0 and result['skipped_sentences'] == 1
    assert result['notice']['level'] == 'warning'
    assert result['notice']['title'] == 'Document not modified'
    assert service.client.writes == []
    assert service.pipeline_provider.inputs == []


# --- the lock ----------------------------------------------------------------

def test_the_lock_is_taken_before_the_document_is_read_and_released_after_the_writes():
    """The parser needs no ``check_unchanged``: unlike a service that reads,
    spends minutes in a model and then writes, it takes the lock FIRST and
    reads inside it, so the plan cannot be built against a document that moves
    underneath it. Moving the read out of the lock would put it in the shape
    ``check_unchanged`` exists for."""
    service = _service()
    servicetest.run(service, REQUEST)

    kinds = service.client.kinds
    assert kinds.count('lock') == 1 and kinds.count('unlock') == 1
    assert kinds.index('lock') < kinds.index('read')
    writes = [i for i, k in enumerate(kinds)
              if k.startswith(('tokens.', 'spans.', 'relations.'))]
    assert kinds.index('lock') < min(writes)
    assert kinds.index('unlock') > max(writes)
    # One read for the version the writes claim, one the plan uses, both
    # under the lock.
    assert kinds.count('read') == 2
    assert [doc for _, doc, _ in service.client.stamps] == ['d1'] * len(writes)


def test_the_lock_is_released_when_a_write_fails():
    service = _service(fails={'spans.bulk_create': PlaidAPIError(
        'HTTP 400 Span value is required at http://plaid.internal:8085/api/v1/spans/bulk',
        status=400, url='http://plaid.internal:8085/api/v1/spans/bulk', method='POST')})
    helper = servicetest.run(service, REQUEST)

    assert service.client.kinds[-1] == 'unlock'
    assert len(helper.errors) == 1
    # The one batch aborted, so nothing reached the server, the tokens it
    # would have replaced included.
    assert service.client.writes == []


def test_a_failed_token_batch_leaves_the_old_words_in_place():
    doc = _document(sentences=[(0, 13)], words=[(0, 3), (4, 7), (8, 13)],
                    morphemes=[('m0', 0, 3), ('m1', 4, 7), ('m2', 8, 13)])
    service = _service(documents=[doc], fails={'tokens.bulk_create': PlaidAPIError(
        'Network error: reset', status=0, url='http://plaid.internal:8085/api/v1/batch',
        method='POST', original_error=ConnectionResetError('reset'))})
    helper = servicetest.run(service, REQUEST)

    assert service.client.writes == []
    assert helper.errors == ['Stanza parser: The Plaid server did not answer. '
                             'This change may or may not have been saved.']


def test_a_document_someone_else_holds_is_refused_without_writing():
    service = _service()
    said = "This document is being edited by ann@x.com. Try again once they're done."

    def locked(document_id):
        raise PlaidAPIError(said, status=423, url='http://plaid.internal:8085/api/v1/lock')

    service.client.documents.locked = locked
    helper = servicetest.run(service, REQUEST)

    # The lock authors its own words for the person who asked, so nothing
    # rewrites them, and the internal URL does not ride along.
    assert helper.errors == [f'Stanza parser: {said}']
    assert service.client.writes == []


# --- refusals ----------------------------------------------------------------

def test_human_work_a_full_reparse_would_destroy_refuses_the_run_once():
    """From-scratch mode cascade-deletes everything under the text layer, other
    apps' layers included, so the guard walks the whole tree and names what is
    in the way."""
    human = {'id': 'sp1', 'tokens': ['m0'], 'value': 'the', 'metadata': {}}
    verified = {'id': 'sp2', 'tokens': ['m1'], 'value': 'NOUN',
                'metadata': {'prov': 'inferred', 'provSource': 'x', 'provConfirmed': True}}
    doc = _document(morphemes=[('m0', 0, 3), ('m1', 4, 7)],
                    spans={'lemmaL': [human], 'uposL': [verified]})
    service = _service(documents=[doc])
    helper = servicetest.run(service, REQUEST)

    assert len(helper.errors) == 1
    text = helper.errors[0]
    assert '2 human-made or human-verified annotation(s)' in text
    assert 'Morphemes/Lemma: 1' in text and 'Morphemes/UPOS: 1' in text
    assert 'Overwrite human-edited annotations' in text
    assert service.client.writes == []
    assert service.client.kinds[-1] == 'unlock'


def test_a_suppressor_protects_nothing_but_an_enhanced_edge_does():
    """The enhanced layer's rows sit beside the tree's. A suppressor is a note
    about a basic relation and carries no provenance, which would read as a
    person's work. It is not one: a parse goes ahead over it. A hand-drawn
    enhanced edge is one, and is in the way like any other."""
    machine = {'prov': 'inferred', 'provSource': SOURCE}
    lemmas = [{'id': 'l0', 'tokens': ['m0'], 'value': 'the', 'metadata': machine},
              {'id': 'l1', 'tokens': ['m1'], 'value': 'dog', 'metadata': machine}]
    suppressor = {'id': 'x1', 'source': 'l1', 'target': 'l0', 'value': None,
                  'metadata': {'suppress': True}}
    edge = {'id': 'e1', 'source': 'l1', 'target': 'l0', 'value': 'det', 'metadata': {}}

    def run(rows):
        doc = _document(morphemes=[('m0', 0, 3), ('m1', 4, 7)],
                        spans={'lemmaL': lemmas}, enhanced_relations=rows)
        return servicetest.run(_service(documents=[doc]), REQUEST)

    assert run([suppressor]).errors == []
    [refusal] = run([suppressor, edge]).errors
    assert '1 human-made or human-verified annotation(s)' in refusal
    assert 'Lemma/Enhanced Dependencies: 1' in refusal


def test_the_tree_is_found_by_its_flag_and_never_by_position():
    """Lemma holds two relation layers. With the flag gone from the tree's, a
    lookup by position would hand back the enhanced layer."""
    enhanced = {'id': 'edepL', 'config': {'ud': {'enhancedDependency': True}}}
    tree = {'id': 'depL', 'config': {'ud': {'dependency': True}}}
    lookup = ud.relation_layer_by_ud_config
    assert lookup({'relation_layers': [enhanced, tree]}, 'dependency') is tree
    assert lookup({'relation_layers': [enhanced]}, 'dependency') is None


def test_overwrite_lets_a_full_reparse_through():
    human = {'id': 'sp1', 'tokens': ['m0'], 'value': 'the', 'metadata': {}}
    doc = _document(morphemes=[('m0', 0, 3)], spans={'lemmaL': [human]})
    service = _service(documents=[doc])
    helper = servicetest.run(service, {**REQUEST, 'overwrite': True})

    assert helper.errors == []
    assert helper.results[0]['parsed_sentences'] == 1
    assert service.client.payloads('tokens.bulk_delete') == [['m0']]


def test_a_project_without_the_substrate_is_refused_once_and_named():
    doc = _document()
    doc['text_layers'][0]['token_layers'][0].pop('config')     # the sentence role
    service = _service(documents=[doc])
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == [SETUP_INCOMPLETE]
    assert service.client.writes == []


def test_an_empty_document_is_refused_once():
    service = _service(documents=[_document(body='   ')])
    helper = servicetest.run(service, REQUEST)

    assert len(helper.errors) == 1
    assert helper.errors[0].endswith('The document has no text.')
    assert service.client.writes == []


def test_a_misaligned_pretokenized_parse_aborts_rather_than_guessing():
    """Stanza returning a different number of words than the sentence has would
    hang every annotation on the wrong word."""
    doc = _document(sentences=[(0, 13)], words=[(0, 3), (4, 7), (8, 13)],
                    morphemes=[('m0', 0, 3), ('m1', 4, 7), ('m2', 8, 13)])
    service = _service(documents=[doc], provider=_PipelineProvider([ROWS[:2]]))
    helper = servicetest.run(service, REQUEST)

    assert len(helper.errors) == 1
    assert 'returned 2 words for a 3-word sentence' in helper.errors[0]
    assert service.client.writes == []
    assert service.client.kinds[-1] == 'unlock'


def test_a_failure_reaches_the_requester_once_without_an_internal_url():
    service = _service(fails={'tokens.bulk_create': PlaidAPIError(
        'HTTP 500 Internal error at http://plaid.internal:8085/api/v1/tokens/bulk',
        status=500, url='http://plaid.internal:8085/api/v1/tokens/bulk', method='POST')})
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == ['Stanza parser: HTTP 500 Internal error']
    assert 'plaid.internal' not in helper.errors[0] and 'http' not in helper.errors[0]


# --- progress through the long stretches -------------------------------------

def test_every_phase_of_the_parse_says_what_it_is_doing():
    service = _service()
    helper = servicetest.run(service, REQUEST)

    assert helper.beats[0] == (2, 'Starting…')
    assert [msg for _, msg in helper.beats] == [
        'Starting…',
        'Reading the document…',
        'Reading the document…',
        'Loading the en models…',
        'Parsing 13 characters…',
        'Parsed 1 sentences…',
        'Writing 1 sentence…',
        'Parsed 1 sentence',
    ]
    # The bar only ever moves forward, through the phases' fixed budget.
    percents = [pct for pct, _ in helper.beats]
    assert percents == sorted(percents), percents
    assert percents[-1] == 100


def test_the_model_load_and_the_parse_both_keep_talking_while_they_run():
    """Two single calls that report nothing of their own: the first parse in a
    language downloads its models, and a whole-document parse cannot be broken
    into steps. The heartbeat is all that stands between a working run and a
    requester who gives up on the silence."""
    import threading

    beaten = threading.Event()
    real_heartbeat = ud.progress_heartbeat
    # The beat's interval is an argument, so a test can ask for it in
    # milliseconds rather than waiting out the real 20 seconds.
    ud.progress_heartbeat = (lambda helper, percent, message, interval_s=0.01:
                             real_heartbeat(helper, percent, message, interval_s=0.01))
    try:
        service = _service(provider=_PipelineProvider(on_parse=lambda: beaten.wait(5)))

        class _Counting(servicetest.Helper):
            def progress(self, percent, msg='', **extra):
                super().progress(percent, msg, **extra)
                if self.messages.count('Parsing 13 characters…') >= 3:
                    beaten.set()

        helper = servicetest.run(service, REQUEST, _Counting())
    finally:
        ud.progress_heartbeat = real_heartbeat

    assert beaten.is_set(), 'the parse went quiet'
    assert helper.messages.count('Parsing 13 characters…') >= 3
    assert helper.errors == [] and len(helper.results) == 1
    # …and the beat stops with the block rather than running on into the writes.
    assert 'Parsing 13 characters…' not in helper.messages[-3:]


# --- stopping ----------------------------------------------------------------

@pytest.mark.parametrize('stop_at', ['Starting…',
                                     'Reading the document…',
                                     'Loading the en models…',
                                     'Parsing 13 characters…'])
def test_a_stop_before_the_writes_ends_the_run_with_one_report(stop_at):
    service = _service()
    helper = servicetest.Helper(stop_when=lambda pct, msg: msg == stop_at)
    servicetest.run(service, REQUEST, helper)

    assert helper.reports == [('completed', {'stopped': True})]
    assert service.client.writes == []


def test_a_stop_between_groups_of_a_long_document_leaves_it_untouched():
    """A pretokenized re-parse reports every SENTENCE_GROUP sentences, and each
    report is a checkpoint: a stop lands between groups, before any write."""
    count = ud.SENTENCE_GROUP + 1
    sentences = [(i * 14, i * 14 + 13) for i in range(count)]
    words = [(i * 14 + b, i * 14 + e) for i in range(count) for b, e in ((0, 3), (4, 7), (8, 13))]
    morphemes = [(f'm{i}', b, e) for i, (b, e) in enumerate(words)]
    doc = _document(body=' '.join([BODY] * count), sentences=sentences,
                    words=words, morphemes=morphemes)
    service = _service(documents=[doc], provider=_PipelineProvider([ROWS] * count))

    helper = servicetest.Helper(stop_when=lambda pct, msg: msg == 'Parsing sentence 1 of 26…')
    servicetest.run(service, REQUEST, helper)

    assert helper.reports == [('completed', {'stopped': True})]
    assert service.client.writes == []
    assert len(service.pipeline_provider.inputs) == 1, 'it stopped after the first group'


def test_a_stop_that_lands_in_the_writes_is_ignored_and_the_run_finishes():
    """Luke's ruling: a stop with nothing left to prevent is silently ignored.
    The whole write phase and the final report sit in one critical block, so a
    stop half-way through a rewrite finishes it rather than leaving a document
    whose tokens are gone and whose annotations never arrived."""
    service = _service()
    helper = servicetest.Helper(stop_when=lambda pct, msg: msg.startswith('Writing 1 sentence'))
    servicetest.run(service, REQUEST, helper)

    assert helper.cancelled, 'the stop never landed, so this proves nothing'
    [result] = helper.results
    assert result['status'] == 'success' and 'stopped' not in result
    assert result['parsed_sentences'] == 1
    assert service.client.payloads('relations.bulk_create') != []
    assert service.client.kinds[-1] == 'unlock'


def test_a_second_request_is_rejected_rather_than_queued():
    """Stanza's pipelines are not thread-safe, which is what the single-flight
    lock is for: a concurrent request is told to try again, not queued behind a
    parse that may outlast its requester's deadline."""
    import threading

    release = threading.Event()
    service = _service(provider=_PipelineProvider(on_parse=lambda: release.wait(5)))

    first = servicetest.Helper()
    thread = service.handle_service_request(dict(REQUEST), first)
    for _ in range(500):
        if service.pipeline_provider.inputs:
            break
        release.wait(0.01)
    second = servicetest.Helper()
    assert service.handle_service_request(dict(REQUEST), second) is None
    assert len(second.errors) == 1 and 'another request' in second.errors[0]
    release.set()
    thread.join(10)
    assert len(first.results) == 1


# --- a long document: a batch per group of sentences (REV-F-PY R1) -----------

def _rows_at(offset):
    return [{**row, 'start_char': row['start_char'] + offset,
             'end_char': row['end_char'] + offset} for row in ROWS]


def _long(count):
    """COUNT copies of BODY, parsed from scratch, one sentence each."""
    starts = [i * 14 for i in range(count)]
    doc = _document(body=' '.join([BODY] * count))
    provider = _PipelineProvider([_rows_at(start) for start in starts], starts)
    return doc, provider


def _wire_bytes(payloads):
    """What a batch's bodies weigh as the client sends them, each ref a null
    in the body and an entry beside it."""
    refs = []

    def default(value):
        refs.append(value)
        return None

    return len(json.dumps(payloads, default=default)) + ud.REF_BYTES * len(refs)


def _sentence_of(op, starts):
    return max(i for i, start in enumerate(starts) if start <= op['begin'])


CAP = 40_000


def test_a_long_parse_goes_in_batches_the_server_takes_each_holding_whole_sentences():
    """A parse over about 4,000 words passed the server's 10 MB body cap in one
    batch and was refused whole with a 413. Each batch now holds whole
    sentences, sized from the cap GET /info publishes."""
    count = 60
    doc, provider = _long(count)
    service = _service(documents=[doc], provider=provider,
                       limits={'json_body_bytes': CAP})
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == []
    [result] = helper.results
    assert result['parsed_sentences'] == count
    batches = service.client.batches
    assert len(batches) > 2
    for batch in batches:
        assert _wire_bytes([payload for _, payload in batch]) <= CAP * 0.6

    # The sentence layer is a partition the server takes only whole: every
    # sentence goes in the first batch, and nowhere else.
    first = batches[0]
    sentence_creates = [p for batch in batches for kind, p in batch
                        if kind == 'tokens.bulk_create' and p[0]['token_layer_id'] == 'sentL']
    assert len(sentence_creates) == 1 and len(sentence_creates[0]) == count
    assert ('tokens.bulk_create', sentence_creates[0]) in first

    # A sentence's syntactic words, spans and relations are in one batch, and
    # every ref in it points at an op of that batch.
    starts = [i * 14 for i in range(count)]
    seen = set()
    for batch in batches:
        morphs = [op for kind, p in batch if kind == 'tokens.bulk_create'
                  for op in p if op['token_layer_id'] == 'morphL']
        here = {_sentence_of(op, starts) for op in morphs}
        assert not here & seen, 'a sentence was written in two batches'
        seen |= here
        rels = [op for kind, p in batch if kind == 'relations.bulk_create' for op in p]
        assert len(rels) == 3 * len(here)
        for kind, payload in batch:
            if kind == 'spans.bulk_create':
                for op in payload:
                    [ref] = op['tokens']
                    assert batch[ref.op][0] == 'tokens.bulk_create'
            if kind == 'relations.bulk_create':
                for op in payload:
                    assert batch[op['source'].op][0] == 'spans.bulk_create'
    assert seen == set(range(count))

    # The words of every sentence land before any of its parse.
    word_batch = {}
    for n, batch in enumerate(batches):
        for kind, p in batch:
            for op in p if kind == 'tokens.bulk_create' else []:
                if op['token_layer_id'] == 'wordL':
                    word_batch.setdefault(_sentence_of(op, starts), n)
    for n, batch in enumerate(batches):
        for kind, p in batch:
            for op in p if kind == 'tokens.bulk_create' else []:
                if op['token_layer_id'] == 'morphL':
                    assert word_batch[_sentence_of(op, starts)] <= n


def test_a_long_reparse_deletes_each_sentences_old_words_in_the_batch_that_replaces_them():
    count = 60
    sentences = [(i * 14, i * 14 + 13) for i in range(count)]
    words = [(i * 14 + b, i * 14 + e) for i in range(count) for b, e in ((0, 3), (4, 7), (8, 13))]
    morphemes = [(f'm{i}', b, e) for i, (b, e) in enumerate(words)]
    doc = _document(body=' '.join([BODY] * count), sentences=sentences,
                    words=words, morphemes=morphemes)
    service = _service(documents=[doc], provider=_PipelineProvider([ROWS] * count),
                       limits={'json_body_bytes': CAP})
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == []
    batches = service.client.batches
    assert len(batches) > 2
    deleted = []
    for batch in batches:
        [(kind, gone)] = [(k, p) for k, p in batch if k == 'tokens.bulk_delete']
        made = [op for k, p in batch if k == 'tokens.bulk_create' for op in p]
        # The words it deletes are the ones it writes anew.
        assert sorted((b, e) for mid, b, e in morphemes if mid in gone) == \
            sorted((op['begin'], op['end']) for op in made)
        deleted += gone
    assert sorted(deleted) == sorted(mid for mid, _, _ in morphemes)


def test_a_failed_later_batch_says_how_many_sentences_were_parsed_in_full():
    count = 60
    doc, provider = _long(count)
    service = _service(documents=[doc], provider=provider,
                       limits={'json_body_bytes': CAP})
    real_batched = service.client.batched
    opened = []

    def batched():
        opened.append(1)
        if len(opened) == 3:
            service.client.fails['relations.bulk_create'] = PlaidAPIError(
                'Network error: reset', status=0, method='POST',
                url='http://plaid.internal:8085/api/v1/batch',
                original_error=ConnectionResetError('reset'))
        return real_batched()

    service.client.batched = batched
    helper = servicetest.run(service, REQUEST)

    assert len(service.client.batches) == 2
    written = {op['begin'] // 14 for batch in service.client.batches for kind, p in batch
               if kind == 'tokens.bulk_create' for op in p if op['token_layer_id'] == 'morphL'}
    assert helper.errors == [f'Stanza parser: {len(written)} of {count} sentences were parsed, '
                             f'each in full. The Plaid server did not answer. '
                             f'This change may or may not have been saved.']
    assert service.client.kinds[-1] == 'unlock'


# --- a from-scratch parse that stopped after its first batch (REV-W-PY2 D1) --

class _TwoPipelines(_PipelineProvider):
    """The tokenizing pipeline answers ROWS over whatever stretch it is given
    (one sentence, offsets from its start); the pretokenized one parses each
    sentence it is handed as ROWS."""

    def get(self, language, pretokenized=False):
        self.asked.append((language, pretokenized))

        def pipeline(value):
            self.inputs.append(value)
            if pretokenized:
                return _Parsed([ROWS] * len(value), [0] * len(value))
            return _Parsed([ROWS], [0])

        return pipeline


def test_a_sentence_with_no_words_is_tokenized_and_parsed_with_its_words():
    """A from-scratch parse whose second batch failed left sentences with no
    words, and every later Parse skipped them while it said it had parsed the
    document. Such a sentence is now tokenized on its own, and its words go in
    the batch that parses it."""
    body = f'{BODY} {BODY}'
    doc = _document(body=body, sentences=[(0, 14), (14, 27)], words=[(0, 3), (4, 7), (8, 13)])
    provider = _TwoPipelines()
    service = _service(documents=[doc], provider=provider)
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == []
    [result] = helper.results
    assert result['mode'] == 'preserve' and result['parsed_sentences'] == 2
    assert ('en', False) in provider.asked and ('en', True) in provider.asked
    assert 'the dog barks' in provider.inputs
    [batch] = service.client.batches
    words = _ops(service.client, 'tokens.bulk_create', 'token_layer_id', 'wordL')
    assert [(w['begin'], w['end']) for w in words] == [(14, 17), (18, 21), (22, 27)]
    assert 'metadata' not in words[0] or not words[0]['metadata'], 'substrate carries no stamp'
    morphemes = _ops(service.client, 'tokens.bulk_create', 'token_layer_id', 'morphL')
    assert sorted((m['begin'], m['end']) for m in morphemes) == \
        [(0, 3), (4, 7), (8, 13), (14, 17), (18, 21), (22, 27)]
    kinds = [kind for kind, _ in batch]
    assert kinds.index('tokens.bulk_create') < len(kinds) - 1
    rels = [op for kind, p in batch if kind == 'relations.bulk_create' for op in p]
    assert len(rels) == 6


def test_a_failure_after_the_sentences_says_what_was_written():
    """The first batch of a long from-scratch parse holds the new sentences
    and the first words. A failure after it said only "HTTP 500"."""
    count = 100
    doc, provider = _long(count)
    service = _service(documents=[doc], provider=provider,
                       limits={'json_body_bytes': CAP})
    real_batched = service.client.batched
    opened = []

    def batched():
        opened.append(1)
        if len(opened) == 2:
            service.client.fails['tokens.bulk_create'] = PlaidAPIError(
                'HTTP 500 boom', status=500, method='POST', url='http://plaid.internal:8085/api/v1/batch')
        return real_batched()

    service.client.batched = batched
    helper = servicetest.run(service, REQUEST)

    [first] = service.client.batches
    worded = {op['begin'] // 14 for kind, p in first if kind == 'tokens.bulk_create'
              for op in p if op['token_layer_id'] == 'wordL'}
    assert 0 < len(worded) < count
    [error] = helper.errors
    assert error.startswith(f'Stanza parser: The {count} sentences were written, and the words of '
                            f'{len(worded)} of them, none parsed. Parse again to finish. ')
    assert 'plaid.internal' not in error


def test_a_write_refused_because_the_request_ended_is_logged_once_without_a_traceback(capsys):
    # conc-2026-09-29 REV-W-TAIL: the harness says in one line that the
    # request had ended (the channel dropped or the server restarted), but
    # the parser printed its own error and traceback above it first, naming
    # another user or token.
    said = ('Operation group g1 was handed to this service by a request that has ended, '
            'so this write cannot join it.')
    service = _service(fails={'tokens.bulk_create': PlaidAPIError(
        f'HTTP 403 {said}', status=403, url='http://plaid.internal:8085/api/v1/batch',
        method='POST', response_data={'error': said})})
    service.client.begin_operation = lambda *a, **k: None
    service.client.end_operation = lambda *a, **k: None
    helper = servicetest.run(service, {**REQUEST, 'operation_group': {'id': 'g1'}})

    assert len(helper.errors) == 1
    out = capsys.readouterr()
    assert 'the request had already ended when this service wrote' in out.out
    assert 'Traceback' not in out.out + out.err
    assert 'Error parsing document' not in out.out
