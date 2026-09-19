"""The AnCast adjudication service: the .umr writer, the metric, the handler.

Three things are under test, and the first two need no server and no fake at
all:

* the ``.umr`` writer, held against the app's own exporter over a released
  corpus (``fixtures/english_raw.json`` and ``fixtures/english_expected.umr``,
  made by ``make_umr_raw_fixture.mjs``)
* the scoring, held against what ``python -m ancast`` prints for the two sample
  files the metric's authors ship
* the REQUEST HANDLER, driven end to end the way ``serve`` would, with the
  documents stood in at the client

Run: pytest -q services/tests, from plaid-umr. Runs from the base env, where
`ancast` is installed.
"""

import contextlib
import json
import pathlib

import pytest
from plaid_client import testing as servicetest
from plaid_client.http import PlaidAPIError

SERVICES = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = pathlib.Path(__file__).resolve().parent / 'fixtures'

umr = servicetest.load_service(SERVICES / 'umr_ancast.py')

DOC = 'd1'
OTHER = 'd2'
PROJECT = 'p1'
#: One sentence, three words. The sentence token takes the newline, so the
#: layer tiles the text the way the importer writes it.
BODY = 'The dog barks\n'
WORDS = [(0, 3), (4, 7), (8, 13)]

REQUEST = {'document_id': DOC, 'project_id': PROJECT, 'against': OTHER, 'scope': 'doc'}


# --- the .umr writer, against the app's own exporter --------------------------

def test_the_writer_produces_exactly_what_the_app_exports():
    """The oracle is the app, not a second reading of the spec.

    ``fixtures/english_raw.json`` is the released English UMR corpus run
    through ``planImport`` and laid out as the Python client hands a document
    back. ``fixtures/english_expected.umr`` is what ``UmrDocument.toUmr()``
    makes of that same document. Both are written by
    ``services/tests/make_umr_raw_fixture.mjs``.

    NOTHING IS EXCLUDED from this comparison: the whole file matches byte for
    byte, sentence headers, graphs, alignment blocks and document level blocks
    alike. The one thing the service does not write is the project's gloss
    lines, and that costs nothing here because the English corpus has none: its
    token blocks are Index and Words, which the service writes. A fixture with
    gloss lines would need them excluded and named.
    """
    raw = json.loads((FIXTURES / 'english_raw.json').read_text())
    expected = (FIXTURES / 'english_expected.umr').read_text()

    assert umr.render_umr(raw) == expected


def test_the_written_file_carries_the_whole_corpus():
    """A guard on the fixture itself: a writer that produced an empty file for
    every sentence would pass the comparison above if the fixture were empty
    too."""
    raw = json.loads((FIXTURES / 'english_raw.json').read_text())
    text = umr.render_umr(raw)

    assert len(umr.split_blocks(text)) == 28
    assert text.count('# sentence level graph:') == 28
    assert '(s1p / override-91' in text
    assert '(document-creation-time :overlap s1f)' in text


def test_the_corpus_the_app_exports_is_one_ancast_reads_whole():
    """Scored against itself, every sentence of the corpus matches perfectly.
    Anything the format got wrong (a block boundary, a missing header) would
    show as a skipped sentence or a score below 1."""
    raw = json.loads((FIXTURES / 'english_raw.json').read_text())
    text = umr.render_umr(raw)

    scores, sentences = umr.score_umr(text, text, 'doc')

    assert [s['index'] for s in sentences if s['skipped']] == []
    assert len(sentences) == 28
    assert scores == {'sentence': 1.0, 'modal': 1.0, 'temporal': 1.0,
                      'coref': 1.0, 'comprehensive': 1.0}


def test_a_discontiguous_alignment_is_collapsed_and_nothing_else_is_touched():
    """ancast's alignment reader calls `int` on the halves of a range, so a
    node anchored to two runs of words takes the whole run with it. The
    sentence header carries commas of its own and must survive untouched."""
    text = ("# :: snt2\tIf it rains , Alana won't water the plants .\n"
            's2a: 1-1,3-4\n'
            's2b: 2-2\n'
            's2c: 0-0\n')

    assert umr.flatten_alignment_ranges(text) == (
        "# :: snt2\tIf it rains , Alana won't water the plants .\n"
        's2a: 1-4\n'
        's2b: 2-2\n'
        's2c: 0-0\n')


# --- the metric, against what `python -m ancast` prints ------------------------
# The two sample files are ancast's own, from umr4nlp/ancast (MIT). The numbers
# below are what
#     python -m ancast -p umr_test.txt -g umr_gold.txt -s doc
# reports: Sent 41.03%, Modality 50.00%, Temporal 54.55%, Coref 0.00%,
# Comprehensive 45.24%.

def _samples():
    return ((FIXTURES / 'umr_test.txt').read_text(),
            (FIXTURES / 'umr_gold.txt').read_text())


def test_the_document_scope_reproduces_the_command_lines_numbers():
    scores, sentences = umr.score_umr(*_samples(), 'doc')

    assert scores == {'sentence': 0.4103, 'modal': 0.5, 'temporal': 0.5455,
                      'coref': 0.0, 'comprehensive': 0.4524}
    assert [s['index'] for s in sentences] == [1, 2]
    assert all(s['skipped'] is None for s in sentences)


def test_the_sentence_scope_scores_the_graphs_and_nothing_else():
    """`-s snt` runs the same per-sentence metric and reports the same micro
    average, with no document-level annotation in it at all."""
    scores, sentences = umr.score_umr(*_samples(), 'snt')

    assert scores['sentence'] == 0.4103
    assert scores['modal'] is None and scores['temporal'] is None
    assert scores['coref'] is None and scores['comprehensive'] is None
    # The per-sentence numbers are the metric's own and do not depend on scope.
    assert [s['concept'] for s in sentences] == [0.95, 0.6]


def test_a_sentence_carries_its_own_scores_and_its_node_matches():
    _, sentences = umr.score_umr(*_samples(), 'doc')

    first, second = sentences
    assert first == {
        'index': 1, 'concept': 0.95, 'labeled': 0.4214, 'unlabeled': 0.4214,
        'weighted': 0.382, 'smatch': 0.48,
        'matches': [['s1x3', 's1l2'], ['s1x0', 's1l'], ['s1x1', 's1p'], ['s1x2', 's1n']],
        'unmatched': [],
        # The gold graph has a node the test graph has nothing for.
        'unmatchedOther': ['s1e'],
        'skipped': None,
    }
    assert second['unmatched'] == [] and second['unmatchedOther'] == []
    assert len(second['matches']) == 5
    # Both sides of a match are plain variables, of the sentence they belong
    # to. ancast's own `Match.gname` formats them as `var / concept`, which is
    # a display string, and the report carries the variables.
    for mine, theirs in first['matches'] + second['matches']:
        assert mine.startswith('s') and theirs.startswith('s')
        assert '/' not in mine and '/' not in theirs


# --- documents ----------------------------------------------------------------

def _node(var, concept, spans, *, attrs=(), root=False, constant=False):
    return {'var': var, 'concept': concept, 'spans': list(spans),
            'attrs': list(attrs), 'root': root, 'constant': constant}


#: `The dog barks`, as `(s1b / bark-01 :ARG0 (s1d / dog))`.
def _barking(concept='dog'):
    return {
        'nodes': [_node('s1b', 'bark-01', [(8, 13)], attrs=[{'rel': ':aspect',
                                                             'value': 'process', 'order': 1}],
                        root=True),
                  _node('s1d', concept, [(4, 7)])],
        'edges': [(0, 1, ':ARG0', 0)],
    }


#: The same sentence with a node the other annotator did not write:
#: `(s1b / bark-01 :ARG0 (s1c / cat) :temporal (s1n / now))`, where `now` is
#: unaligned and so takes a zero-width anchor at the sentence's start.
def _barking_and_now(concept='cat'):
    graph = _barking(concept)
    graph['nodes'] = graph['nodes'] + [_node('s1n', 'now', [(0, 0)])]
    graph['edges'] = graph['edges'] + [(0, 2, ':temporal', 2)]
    return graph


def _document(doc_id=DOC, *, name='Ann', version=7, metadata=None, body=BODY,
              sentences=((0, 14),), words=WORDS, nodes=(), edges=(), triples=()):
    """A UMR document: the substrate by its shared roles, the node / concept /
    relation layers by their `config.umr` flags."""
    node_tokens = []
    concept_spans = []
    for i, node in enumerate(nodes):
        token_ids = []
        for j, (begin, end) in enumerate(node['spans']):
            token_ids.append(f'{doc_id}n{i}_{j}')
            node_tokens.append({'id': token_ids[-1], 'begin': begin, 'end': end})
        meta = {'var': node['var'], 'attrs': node['attrs']}
        if node['root']:
            meta['root'] = True
        if node['constant']:
            meta['constant'] = True
        concept_spans.append({'id': f'{doc_id}s{i}', 'tokens': token_ids,
                              'value': node['concept'], 'metadata': {'umr': meta}})

    def relation(prefix, i, spec):
        source, target, value, extra = spec[0], spec[1], spec[2], spec[3]
        return {'id': f'{doc_id}{prefix}{i}', 'source': f'{doc_id}s{source}',
                'target': f'{doc_id}s{target}', 'value': value,
                'metadata': {'umr': extra}}

    document = {
        'id': doc_id, 'name': name, 'version': version,
        'text_layers': [{
            'id': 'textL', 'name': 'Baseline', 'config': {'plaid': {'role': 'baseline'}},
            'text': {'id': f'{doc_id}-text', 'body': body},
            'token_layers': [
                {'id': 'sentL', 'name': 'Sentences', 'config': {'plaid': {'role': 'sentence'}},
                 'tokens': [{'id': f'{doc_id}sent{i}', 'begin': b, 'end': e}
                            for i, (b, e) in enumerate(sentences)],
                 'span_layers': []},
                {'id': 'wordL', 'name': 'Words', 'config': {'plaid': {'role': 'word'}},
                 'tokens': [{'id': f'{doc_id}w{i}', 'begin': b, 'end': e}
                            for i, (b, e) in enumerate(words)],
                 'span_layers': []},
                {'id': 'nodeL', 'name': 'UMR nodes', 'config': {'umr': {'nodes': True}},
                 'tokens': node_tokens,
                 'span_layers': [{
                     'id': 'conceptL', 'name': 'UMR concepts',
                     'config': {'umr': {'concepts': True}}, 'spans': concept_spans,
                     'relation_layers': [
                         {'id': 'relL', 'name': 'UMR relations',
                          'config': {'umr': {'relations': True}},
                          'relations': [relation('r', i, (s, t, v, {'order': o}))
                                        for i, (s, t, v, o) in enumerate(edges)]},
                         {'id': 'docL', 'name': 'UMR document graph',
                          'config': {'umr': {'documentGraph': True}},
                          'relations': [relation('t', i, spec) for i, spec in enumerate(triples)]},
                     ],
                 }]},
            ],
        }],
    }
    if metadata is not None:
        document['metadata'] = metadata
    return document


# --- the client ---------------------------------------------------------------

class _Documents:
    """Documents by id rather than by read order, because this service reads
    two of them and then re-reads the first for the unchanged check."""

    def __init__(self, client, documents, on_read=None):
        self._client = client
        self._by_id = {d['id']: d for d in documents}
        self._on_read = on_read

    def get(self, document_id, include_body=None, layers=None):
        self._client.reads.append({'id': document_id, 'layers': layers})
        self._client.record('read', document_id)
        if self._on_read:
            self._on_read(document_id)
        document = self._by_id.get(document_id)
        if document is None:
            raise PlaidAPIError(f'HTTP 404 Document {document_id} not found', status=404,
                                url='http://plaid.internal:8085/api/v1/documents')
        return document

    def patch_metadata(self, document_id, body, audit_message=None):
        self._client.fail_if_asked('documents.patch_metadata')
        self._client.record('documents.patch_metadata', (document_id, body))

    @contextlib.contextmanager
    def locked(self, document_id):
        self._client.calls.append(('lock', document_id))
        try:
            yield self
        finally:
            self._client.calls.append(('unlock', document_id))


class _Projects:
    def __init__(self, entries):
        self._entries = entries

    def list_documents(self, project_id):
        return self._entries


class _Client(servicetest.FakeClient):
    def __init__(self, documents, entries=None, fails=None, on_read=None):
        super().__init__(list(documents), fails=fails)
        self.documents = _Documents(self, documents, on_read)
        self.projects = _Projects(
            entries if entries is not None
            else [{'id': d['id'], 'name': d.get('name')} for d in documents])


def _service(documents=None, *, entries=None, fails=None, on_read=None):
    service = umr.UmrAncastService()
    if documents is None:
        documents = [_document(DOC, name='Ann', **_barking()),
                     _document(OTHER, name='Bo', **_barking_and_now())]
    service.client = _Client(documents, entries=entries, fails=fails, on_read=on_read)
    return service


def _patch(client):
    [(document_id, body)] = client.payloads('documents.patch_metadata')
    return document_id, body


# --- the happy path -----------------------------------------------------------

def test_a_run_writes_the_report_on_the_scored_document_and_reports_the_scores():
    service = _service()
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == []
    [result] = helper.results
    assert result['status'] == 'success'
    assert result['document_id'] == DOC
    assert result['against'] == {'id': OTHER, 'name': 'Bo'}
    assert result['scope'] == 'doc'
    assert (result['sentences'], result['sentences_scored'],
            result['sentences_skipped']) == (1, 1, 0)

    document_id, body = _patch(service.client)
    assert document_id == DOC
    report = body['umr']['adjudication']
    assert report['version'] == 1
    assert report['tool'].startswith('ancast ')
    assert report['against'] == {'id': OTHER, 'name': 'Bo'}
    assert report['scope'] == 'doc'
    assert report['at'].endswith('Z') and len(report['at']) == 20
    assert set(report['scores']) == {'sentence', 'modal', 'temporal', 'coref', 'comprehensive'}
    # The report the run reports and the report it stored are the same scores.
    assert report['scores'] == result['scores']

    [sentence] = report['sentences']
    assert sentence['index'] == 1
    assert sentence['skipped'] is None
    assert set(sentence) == {'index', 'concept', 'labeled', 'unlabeled', 'weighted',
                             'smatch', 'matches', 'unmatched', 'unmatchedOther', 'skipped'}
    # bark-01 is in both. ancast's greedy pass pairs the leftovers too, so
    # `dog` and `cat` come back as a match of poor quality rather than as two
    # unmatched nodes. The other document's third node has nothing to pair
    # with and is the one reported unmatched.
    assert sentence['matches'] == [['s1b', 's1b'], ['s1d', 's1d']]
    assert sentence['unmatched'] == []
    assert sentence['unmatchedOther'] == ['s1n']
    for key in ('concept', 'labeled', 'unlabeled', 'weighted', 'smatch'):
        assert 0.0 <= sentence[key] <= 1.0, key

    assert service.client.operations == ['AnCast adjudication against Bo']


def test_two_identical_annotations_score_one_and_the_notice_says_so():
    service = _service([_document(DOC, name='Ann', **_barking()),
                        _document(OTHER, name='Bo', **_barking())])
    helper = servicetest.run(service, REQUEST)

    [result] = helper.results
    assert result['scores']['sentence'] == 1.0
    assert result['notice'] == {
        'level': 'success',
        'title': 'Sentence graphs 1.00, comprehensive 1.00 against Bo',
        'message': 'Scored 1 sentence.',
    }


def test_the_sentence_scope_reports_no_document_level_scores():
    service = _service()
    helper = servicetest.run(service, {**REQUEST, 'scope': 'snt'})

    [result] = helper.results
    assert result['scope'] == 'snt'
    assert result['scores']['sentence'] is not None
    assert result['scores']['comprehensive'] is None
    _, body = _patch(service.client)
    assert body['umr']['adjudication']['scope'] == 'snt'
    # The title names only what was scored.
    assert 'comprehensive' not in result['notice']['title']


def test_the_other_document_is_found_by_its_exact_name():
    service = _service()
    helper = servicetest.run(service, {**REQUEST, 'against': 'Bo'})

    assert helper.errors == []
    [result] = helper.results
    assert result['against'] == {'id': OTHER, 'name': 'Bo'}


def test_a_sentence_ancast_cannot_read_is_reported_as_unscored():
    """A sentence with no graph at all is not a graph ancast can parse. It is
    named in the report rather than going missing from the list."""
    two = {'body': 'The dog barks\nIt runs\n',
           'sentences': ((0, 14), (14, 22)),
           'words': WORDS + [(14, 16), (17, 21)]}
    service = _service([_document(DOC, name='Ann', **two, **_barking()),
                        _document(OTHER, name='Bo', **two, **_barking('cat'))])
    helper = servicetest.run(service, REQUEST)

    [result] = helper.results
    assert (result['sentences'], result['sentences_scored'],
            result['sentences_skipped']) == (2, 1, 1)
    _, body = _patch(service.client)
    first, second = body['umr']['adjudication']['sentences']
    assert first['skipped'] is None
    assert second['index'] == 2 and second['skipped']
    assert second['concept'] is None and second['matches'] == []
    assert 'could not read' in result['notice']['message']


# --- the metadata write -------------------------------------------------------

def test_the_umr_namespace_is_restated_so_nothing_else_in_it_is_lost():
    """A document metadata PATCH replaces a nested namespace wholesale, so the
    report has to be written beside what is already under `umr` rather than
    over it."""
    service = _service([
        _document(DOC, name='Ann', metadata={
            'umr': {'lang': 'eng', 'adjudication': {'version': 1, 'tool': 'ancast 0.0.0'}},
            'note': 'kept by the shallow patch',
        }, **_barking()),
        _document(OTHER, name='Bo', **_barking('cat')),
    ])
    servicetest.run(service, REQUEST)

    _, body = _patch(service.client)
    # The whole namespace, restated: the other key survives and the old report
    # is replaced.
    assert set(body) == {'umr'}
    assert body['umr']['lang'] == 'eng'
    assert body['umr']['adjudication']['tool'] != 'ancast 0.0.0'
    # `note` is a sibling of `umr` and the patch is shallow at the top level,
    # so leaving it out of the body leaves it untouched.
    assert 'note' not in body


def test_a_document_with_no_umr_metadata_yet_gets_just_the_report():
    service = _service()
    servicetest.run(service, REQUEST)

    _, body = _patch(service.client)
    assert list(body['umr']) == ['adjudication']


# --- the refusals -------------------------------------------------------------

def test_a_document_cannot_be_scored_against_itself():
    service = _service()
    helper = servicetest.run(service, {**REQUEST, 'against': DOC})

    assert helper.errors == ['A document cannot be scored against itself. '
                             "Pick the other annotator's copy."]
    assert service.client.writes == []


def test_its_own_name_is_refused_the_same_way_as_its_own_id():
    service = _service()
    helper = servicetest.run(service, {**REQUEST, 'against': 'Ann'})

    assert 'against itself' in helper.errors[0]
    assert service.client.writes == []


def test_a_name_two_documents_share_is_a_refusal_and_not_a_choice():
    """Guessing would score one document and name it in the report as the
    other."""
    service = _service(entries=[{'id': DOC, 'name': 'Ann'},
                                {'id': OTHER, 'name': 'Bo'},
                                {'id': 'd3', 'name': 'Bo'}])
    helper = servicetest.run(service, {**REQUEST, 'against': 'Bo'})

    assert len(helper.errors) == 1
    assert '2 documents in this project are called "Bo"' in helper.errors[0]
    assert 'by its id' in helper.errors[0]
    assert service.client.writes == []


def test_a_name_no_document_in_the_project_has_is_refused():
    service = _service()
    helper = servicetest.run(service, {**REQUEST, 'against': 'Cy'})

    assert 'no document called "Cy"' in helper.errors[0]
    assert service.client.writes == []


def test_a_missing_against_is_refused_before_anything_is_read():
    service = _service()
    helper = servicetest.run(service, {**REQUEST, 'against': ''})

    assert helper.errors == ['Name the document to score this one against.']
    assert service.client.writes == []


def test_two_documents_over_different_words_are_refused():
    """Scoring two annotations of different texts would produce a number, and
    the number would mean nothing."""
    other = _document(OTHER, name='Bo', body='The cat barks\n', **_barking('cat'))
    service = _service([_document(DOC, name='Ann', **_barking()), other])
    helper = servicetest.run(service, REQUEST)

    assert len(helper.errors) == 1
    assert 'Sentence 1 differs' in helper.errors[0]
    assert '"The dog barks"' in helper.errors[0] and '"The cat barks"' in helper.errors[0]
    assert service.client.writes == []


def test_two_documents_with_different_sentence_counts_are_refused():
    other = _document(OTHER, name='Bo', body='The dog barks\nIt runs\n',
                      sentences=((0, 14), (14, 22)), words=WORDS + [(14, 16), (17, 21)],
                      **_barking('cat'))
    service = _service([_document(DOC, name='Ann', **_barking()), other])
    helper = servicetest.run(service, REQUEST)

    assert '"Ann" has 1 sentences and "Bo" 2' in helper.errors[0]
    assert service.client.writes == []


def test_a_document_that_is_not_set_up_for_umr_is_refused_once_and_named():
    document = _document(DOC, name='Ann', **_barking())
    # The document graph layer's flag.
    document['text_layers'][0]['token_layers'][2]['span_layers'][0][
        'relation_layers'][1]['config'] = {}
    service = _service([document, _document(OTHER, name='Bo', **_barking('cat'))])
    helper = servicetest.run(service, REQUEST)

    assert len(helper.errors) == 1
    assert 'not set up for UMR' in helper.errors[0]
    assert 'document graph layer' in helper.errors[0]
    assert service.client.writes == []


def test_a_document_that_moved_while_the_metric_ran_is_not_written_to():
    """The scores describe the document as it was read. If it has moved since,
    the report would be a claim about a state that is gone."""
    document = _document(DOC, name='Ann', **_barking())

    def bump(document_id):
        if document_id == DOC:
            document['version'] = document['version'] + 1

    service = _service([document, _document(OTHER, name='Bo', **_barking('cat'))],
                       on_read=bump)
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == ['The document changed while this run was working. Run it again.']
    assert service.client.writes == []
    assert service.client.kinds[-1] == 'unlock'


# --- the lock -----------------------------------------------------------------

def test_the_lock_is_taken_around_the_write_and_released_after_it():
    service = _service()
    servicetest.run(service, REQUEST)

    kinds = service.client.kinds
    assert kinds.count('lock') == 1 and kinds.count('unlock') == 1
    # Both documents are read OUTSIDE the lock: the metric runs on text, and
    # holding the document through it would block the annotator for no reason,
    # which check_unchanged covers instead.
    assert kinds.index('read') < kinds.index('lock')
    write = kinds.index('documents.patch_metadata')
    assert kinds.index('lock') < write < kinds.index('unlock')


def test_the_lock_is_released_when_the_write_fails():
    service = _service(fails={'documents.patch_metadata': PlaidAPIError(
        'HTTP 400 Bad metadata at http://plaid.internal:8085/api/v1/documents/d1/metadata',
        status=400, url='http://plaid.internal:8085/api/v1/documents/d1/metadata',
        method='PATCH')})
    helper = servicetest.run(service, REQUEST)

    assert service.client.kinds[-1] == 'unlock'
    assert helper.errors == ['AnCast adjudication: HTTP 400 Bad metadata']
    assert 'plaid.internal' not in helper.errors[0]


def test_a_document_someone_else_holds_is_refused_without_writing():
    service = _service()
    said = ("Document d1 is locked by ann@x.com (likely being edited); "
            "try again once they're done.")

    def locked(document_id):
        raise PlaidAPIError(said, status=423, url='http://plaid.internal:8085/api/v1/lock')

    service.client.documents.locked = locked
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == [f'AnCast adjudication: {said}']
    assert service.client.writes == []


# --- progress and stopping ----------------------------------------------------

def test_every_phase_says_what_it_is_doing_and_the_bar_only_moves_forward():
    service = _service()
    helper = servicetest.run(service, REQUEST)

    assert [msg for _, msg in helper.beats] == [
        'Reading the document…',
        'Reading the other document…',
        'Reading the other document…',
        'Scoring against Bo…',
        'Writing the report…',
        helper.results[0]['notice']['title'],
    ]
    percents = [pct for pct, _ in helper.beats]
    assert percents == sorted(percents), percents
    assert percents[-1] == 100


@pytest.mark.parametrize('stop_at', ['Reading the document…', 'Scoring against Bo…'])
def test_a_stop_before_the_write_ends_the_run_with_one_report(stop_at):
    service = _service()
    helper = servicetest.Helper(stop_when=lambda pct, msg: msg == stop_at)
    servicetest.run(service, REQUEST, helper)

    assert helper.reports == [('completed', {'stopped': True})]
    assert service.client.writes == []


def test_a_stop_that_lands_in_the_write_is_ignored_and_the_run_finishes():
    """A stop with nothing left to prevent is silently ignored: the write and
    the final report are one critical block."""
    service = _service()
    helper = servicetest.Helper(stop_when=lambda pct, msg: msg == 'Writing the report…')
    servicetest.run(service, REQUEST, helper)

    assert helper.cancelled, 'the stop never landed, so this proves nothing'
    [result] = helper.results
    assert result['status'] == 'success' and 'stopped' not in result
    assert service.client.payloads('documents.patch_metadata') != []
    assert service.client.kinds[-1] == 'unlock'


# --- how the service describes itself -----------------------------------------

def test_the_service_serves_the_compare_task_with_scope_as_its_one_parameter():
    """`against` is not a parameter: the Compare tab owns the document picker
    and passes it as a request argument, so a text box in the run dialog would
    be a second and worse way to say the same thing."""
    service = umr.UmrAncastService()

    assert service.service_id == 'umr-ancast'
    assert service.service_name == 'AnCast adjudication'
    assert service.extras['tasks'] == ['compare']
    [scope] = service.extras['parameters']
    assert scope['key'] == 'scope'
    assert [o['value'] for o in scope['options']] == ['doc', 'snt']
    assert scope['default'] == 'doc'
    assert '**Document**' in service.extras['summary']
    assert '**Scope**' in service.extras['summary']
