"""The UMR drafting service's REQUEST HANDLER, driven end to end.

The model is replaced at its one seam -- ``service.model``, a ChatModel with
``complete`` / ``describe`` / ``usage_line`` -- and the document at the client.
So a whole run (read, prompt, parse the reply, write the anchors, nodes and
relations, report) happens in milliseconds with no provider, no key and no
server. litellm is never imported: the service imports it only inside
``ChatModel.complete``, which nothing here reaches.

Run: pytest -q services/tests, from plaid-umr. Runs from the base env.
"""

import pathlib

import pytest
from plaid_client import testing as servicetest
from plaid_client.http import PlaidAPIError
from plaid_client.workflows.llm import Reply

SERVICES = pathlib.Path(__file__).resolve().parent.parent

umr = servicetest.load_service(SERVICES / 'umr_draft_llm.py')

DOC = 'd1'
PROJECT = 'p1'
#: One sentence, three words. The sentence token takes the newline, so the
#: layer tiles the text the way the importer writes it.
BODY = 'The dog barks\n'
WORDS = [(0, 3), (4, 7), (8, 13)]
SOURCE = 'service:umr-draft-llm'
KEY = 'sk-live-0123456789abcdef'

REQUEST = {'document_id': DOC, 'project_id': PROJECT,
           'scope': 'document', 'sentence': 1, 'overwrite': False}

#: A well-formed reply. The variables are deliberately NOT the project's
#: convention: the service re-generates them, so a model that invents its own
#: naming cannot collide with what the document already holds.
GOOD_REPLY = """\
(v1 / bark-01
    :ARG0 (v2 / dog
        :refer-number singular)
    :aspect process
    :temporal (v3 / now))

# alignment:
v1: 3-3
v2: 2-2
v3: 0-0
"""


# --- the seams ---------------------------------------------------------------

class _Model:
    """Stands in for a ChatModel: records what it was asked and replies with a
    fixed text, or raises."""

    def __init__(self, replies=None, error=None, truncated=False):
        self.calls = []          # (system, user)
        self._replies = list(replies if replies is not None else [GOOD_REPLY])
        self._error = error
        self._truncated = truncated

    def complete(self, system, user):
        self.calls.append((system, user))
        if self._error:
            raise self._error
        text = self._replies[min(len(self.calls) - 1, len(self._replies) - 1)]
        return Reply(text=text, truncated=self._truncated)

    def describe(self):
        return {'model': 'openai/gpt-4o-mini'}

    def usage_line(self):
        return 'openai/gpt-4o-mini: 1 call(s)'

    @property
    def prompts(self):
        return [user for _, user in self.calls]


def _token(token_id, begin, end):
    return {'id': token_id, 'begin': begin, 'end': end}


def _document(*, body=BODY, sentences=((0, 14),), words=WORDS, node_tokens=(),
              concept_spans=(), relations=(), gloss_spans=None, version=7):
    """A UMR document: the substrate by its shared roles, the node / concept /
    relation layers by their `config.umr` flags, and one word-scoped gloss
    field from another app sharing the project."""
    gloss_layer = {
        'id': 'glossL', 'name': 'Gloss', 'config': {'igt': {'scope': 'Word'}},
        'spans': list(gloss_spans if gloss_spans is not None else [
            {'id': 'g1', 'tokens': ['w1'], 'value': 'DET'},
            {'id': 'g2', 'tokens': ['w2'], 'value': 'dog'},
            {'id': 'g3', 'tokens': ['w3'], 'value': 'bark.PRS'},
        ]),
    }
    concept_layer = {
        'id': 'conceptL', 'name': 'UMR concepts', 'config': {'umr': {'concepts': True}},
        'spans': list(concept_spans),
        'relation_layers': [
            {'id': 'relL', 'name': 'UMR relations', 'config': {'umr': {'relations': True}},
             'relations': list(relations)},
            {'id': 'docL', 'name': 'UMR document graph',
             'config': {'umr': {'documentGraph': True}}, 'relations': []},
        ],
    }
    return {
        'id': DOC,
        'version': version,
        'text_layers': [{
            'id': 'textL', 'name': 'Baseline', 'config': {'plaid': {'role': 'baseline'}},
            'text': {'id': 'text-1', 'body': body},
            'token_layers': [
                {'id': 'sentL', 'name': 'Sentences', 'config': {'plaid': {'role': 'sentence'}},
                 'tokens': [_token(f's{i + 1}', b, e) for i, (b, e) in enumerate(sentences)],
                 'span_layers': []},
                {'id': 'wordL', 'name': 'Words', 'config': {'plaid': {'role': 'word'}},
                 'tokens': [_token(f'w{i + 1}', b, e) for i, (b, e) in enumerate(words)],
                 'span_layers': [gloss_layer]},
                {'id': 'nodeL', 'name': 'UMR nodes', 'config': {'umr': {'nodes': True}},
                 'tokens': [_token(*t) for t in node_tokens],
                 'span_layers': [concept_layer]},
            ],
        }],
    }


def _project(language='English'):
    return {'id': PROJECT, 'name': 'UMR', 'config': {'umr': {'language': language}}}


class _Client(servicetest.FakeClient):
    """The fake client plus the one read the service makes of the project."""

    def __init__(self, documents, project=None, fails=None):
        super().__init__(documents, fails=fails)
        self.projects = self._Projects(project if project is not None else _project())

    class _Projects:
        def __init__(self, project):
            self._project = project

        def get(self, project_id, **kwargs):
            return self._project


def _service(*, documents=None, project=None, fails=None, model=None):
    service = umr.UmrDraftService()
    service.model = model or _Model()
    service.REQUEST_SECRETS = (KEY,)
    service.client = _Client(documents or [_document()], project=project, fails=fails)
    return service


def _ops(client, kind):
    return [op for payload in client.payloads(kind) for op in payload]


# --- the prompt --------------------------------------------------------------

def test_the_prompt_names_the_numbered_words_and_the_projects_gloss_field():
    service = _service()
    servicetest.run(service, REQUEST)

    [prompt] = service.model.prompts
    assert 'Language: English.' in prompt
    assert '1 The' in prompt and '2 dog' in prompt and '3 barks' in prompt
    # The gloss layer is named and its values are listed against the word
    # numbers, so the model can tell which word each one belongs to.
    assert 'Gloss: 1 DET  2 dog  3 bark.PRS' in prompt
    assert 'Write the UMR graph for sentence 1' in prompt

    # The reference the model works from is sent once, as the system prompt.
    [(system, _)] = service.model.calls
    assert ':aspect' in system and 'full-affirmative' in system
    assert '# alignment:' in system


def test_a_field_with_nothing_in_it_is_not_sent_as_a_line():
    service = _service(documents=[_document(gloss_spans=[])])
    servicetest.run(service, REQUEST)

    assert 'Gloss:' not in service.model.prompts[0]


# --- the happy path ----------------------------------------------------------

def test_a_good_answer_becomes_anchors_nodes_and_relations():
    service = _service()
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == []
    [result] = helper.results
    assert result['status'] == 'success'
    assert (result['drafted'], result['skipped'], result['failed']) == (1, 0, 0)
    assert result['notice'] == {'level': 'success', 'title': 'Drafted 1 sentence',
                                'message': ''}
    assert 'stopped' not in result

    # Three anchors, one per node, in the order the graph was written.
    anchors = _ops(service.client, 'tokens.bulk_create')
    assert [(a['begin'], a['end']) for a in anchors] == [(8, 13), (4, 7), (0, 14)]
    assert {a['token_layer_id'] for a in anchors} == {'nodeL'}
    assert {a['text'] for a in anchors} == {'text-1'}

    nodes = _ops(service.client, 'spans.bulk_create')
    assert [n['value'] for n in nodes] == ['bark-01', 'dog', 'now']
    assert {n['span_layer_id'] for n in nodes} == {'conceptL'}
    # Each node takes its own anchor.
    assert [n['tokens'] for n in nodes] == [['tokens-1'], ['tokens-2'], ['tokens-3']]

    umr_meta = [n['metadata']['umr'] for n in nodes]
    # The project's variable rule, re-generated: the model's v1/v2/v3 are gone.
    assert [m['var'] for m in umr_meta] == ['s1b', 's1d', 's1n']
    # Attributes and edges share ONE order space: the child's position in the
    # PENMAN node. :aspect is the second child of the root, between the two
    # edges, and keeps order 1.
    assert umr_meta[0]['attrs'] == [{'rel': ':aspect', 'value': 'process', 'order': 1}]
    assert umr_meta[1]['attrs'] == [{'rel': ':refer-number', 'value': 'singular', 'order': 0}]
    assert umr_meta[2]['attrs'] == []
    # Only the root is the root.
    assert umr_meta[0]['root'] is True
    assert 'root' not in umr_meta[1] and 'root' not in umr_meta[2]

    [relations] = service.client.payloads('relations.bulk_create')
    assert [(r['value'], r['source'], r['target'], r['metadata']['umr'])
            for r in relations] == [
        (':ARG0', 'spans-4', 'spans-5', {'order': 0}),
        (':temporal', 'spans-4', 'spans-6', {'order': 2}),
    ]
    assert {r['relation_layer_id'] for r in relations} == {'relL'}

    # Everything it writes is machine-made and nobody has vouched for it.
    for op in nodes + relations:
        meta = op['metadata']
        assert meta['prov'] == 'inferred'
        assert meta['provSource'] == SOURCE
        assert 'provConfirmed' not in meta
        assert meta['provDetail'] == {'model': 'openai/gpt-4o-mini', 'language': 'English'}

    assert service.client.operations == ['UMR draft (1 sentences)']


def test_an_alignment_lands_on_the_words_it_names_and_0_0_is_unaligned():
    """`2-2` is the second word's own offsets; `0-0` (not overtly realized) is
    an anchor over the whole sentence, which is how the importer stores a node
    aligned to no word: the sentence record is what says so, and an anchor
    that covers the sentence survives an edit to the text around it."""
    service = _service()
    servicetest.run(service, REQUEST)

    by_concept = dict(zip([n['value'] for n in _ops(service.client, 'spans.bulk_create')],
                          _ops(service.client, 'tokens.bulk_create')))
    assert (by_concept['dog']['begin'], by_concept['dog']['end']) == (4, 7)
    assert (by_concept['now']['begin'], by_concept['now']['end']) == (0, 14)
    # The unaligned node records its sentence, as the app does, and an
    # aligned one does not.
    meta = {n['value']: n['metadata']['umr'] for n in _ops(service.client, 'spans.bulk_create')}
    assert meta['now']['sentence'] == 's1'
    assert 'sentence' not in meta['dog']


def test_a_discontiguous_alignment_becomes_one_anchor_per_run_of_words():
    reply = '(v1 / bark-01)\n\n# alignment:\nv1: 1-1,3-3\n'
    service = _service(model=_Model([reply]))
    servicetest.run(service, REQUEST)

    anchors = _ops(service.client, 'tokens.bulk_create')
    assert [(a['begin'], a['end']) for a in anchors] == [(0, 3), (8, 13)]
    [node] = _ops(service.client, 'spans.bulk_create')
    assert node['tokens'] == ['tokens-1', 'tokens-2']


def test_the_scope_of_one_sentence_drafts_only_that_sentence():
    doc = _document(body='The dog barks\nIt runs\n',
                    sentences=[(0, 14), (14, 22)],
                    words=WORDS + [(14, 16), (17, 21)])
    service = _service(documents=[doc])
    helper = servicetest.run(service, {**REQUEST, 'scope': 'sentence', 'sentence': 2})

    assert len(service.model.calls) == 1
    assert 'Sentence 2: It runs' in service.model.prompts[0]
    [result] = helper.results
    assert result['drafted'] == 1 and result['sentences'] == 2
    # Sentence 2's variables carry its own number.
    assert [n['metadata']['umr']['var'] for n in _ops(service.client, 'spans.bulk_create')] == \
        ['s2b', 's2d', 's2n']


def test_a_sentence_number_the_document_lacks_is_refused_without_writing():
    service = _service()
    helper = servicetest.run(service, {**REQUEST, 'scope': 'sentence', 'sentence': 4})

    assert helper.errors == ['The document has no sentence 4.']
    assert service.client.writes == []
    assert service.model.calls == []


# --- the write contract ------------------------------------------------------

def _drafted_document(node_metadata=None):
    """The same document with sentence 1 already drafted: one node anchored to
    the first word. By default the node is a machine's, unverified, which is
    what an `overwrite` run is allowed to replace."""
    metadata = {'umr': {'var': 's1d', 'attrs': []}}
    metadata.update({'prov': 'inferred', 'provSource': SOURCE}
                    if node_metadata is None else node_metadata)
    return _document(
        node_tokens=[('n1', 0, 3)],
        concept_spans=[{'id': 'sp1', 'tokens': ['n1'], 'value': 'dog',
                        'metadata': metadata}])


def test_a_sentence_that_already_has_a_graph_is_skipped_and_counted():
    service = _service(documents=[_drafted_document()])
    helper = servicetest.run(service, REQUEST)

    [result] = helper.results
    assert (result['drafted'], result['skipped'], result['failed']) == (0, 1, 0)
    assert result['notice']['level'] == 'warning'
    assert result['notice']['title'] == 'Document not modified'
    assert 'Overwrite existing graphs' in result['notice']['message']
    assert service.client.writes == []
    assert service.model.calls == [], 'a skipped sentence costs no model call'


def test_overwrite_deletes_the_old_anchors_before_writing_the_new_graph():
    """The anchors go first and the server cascades: their concept spans, and
    with them the edges and document-level triples hung off those spans."""
    service = _service(documents=[_drafted_document()])
    helper = servicetest.run(service, {**REQUEST, 'overwrite': True})

    [result] = helper.results
    assert (result['drafted'], result['skipped'], result['failed']) == (1, 0, 0)
    assert service.client.payloads('tokens.bulk_delete') == [['n1']]
    kinds = service.client.kinds
    assert kinds.index('tokens.bulk_delete') < kinds.index('tokens.bulk_create')
    # The replaced graph frees its variable, so the redraft writes s1d again
    # rather than s1d2.
    assert [n['metadata']['umr']['var'] for n in _ops(service.client, 'spans.bulk_create')] == \
        ['s1b', 's1d', 's1n']
    assert result['kept'] == 0


# The machine-writer contract, rule 2: `overwrite` is an opt-in to replace the
# MACHINE's own drafts, never a person's work. A sentence somebody built or
# confirmed is kept, counted, and named in the report.
@pytest.mark.parametrize('node_metadata, why', [
    ({}, 'hand-made'),
    ({'prov': 'inferred', 'provSource': SOURCE, 'provConfirmed': True}, 'verified'),
    ({'prov': 'contributed', 'provSource': 'user:a@b.com'}, 'contributed'),
])
def test_overwrite_keeps_a_sentence_a_person_built_or_confirmed(node_metadata, why):
    service = _service(documents=[_drafted_document(node_metadata)])
    helper = servicetest.run(service, {**REQUEST, 'overwrite': True})

    [result] = helper.results
    assert (result['drafted'], result['skipped'], result['kept']) == (0, 0, 1), why
    assert service.client.writes == [], f'a {why} graph is not deleted'
    assert service.model.calls == [], f'a {why} sentence costs no model call'
    assert result['notice'] == {'level': 'warning', 'title': 'Document not modified',
                                'message': 'Kept 1 verified sentence.'}


def test_overwrite_redrafts_the_machine_sentences_beside_a_kept_one():
    """Two sentences, one drafted by the service and one by a person: the
    machine's is replaced, the person's is kept, and the run says so."""
    body = 'The dog barks\nThe cat sleeps\n'
    document = _document(
        body=body, sentences=((0, 14), (14, 30)),
        words=[(0, 3), (4, 7), (8, 13), (14, 17), (18, 21), (22, 28)],
        node_tokens=[('n1', 0, 3), ('n2', 14, 17)],
        concept_spans=[
            {'id': 'sp1', 'tokens': ['n1'], 'value': 'dog',
             'metadata': {'umr': {'var': 's1d', 'attrs': []},
                          'prov': 'inferred', 'provSource': SOURCE}},
            {'id': 'sp2', 'tokens': ['n2'], 'value': 'cat',
             'metadata': {'umr': {'var': 's2c', 'attrs': []}}},
        ])
    service = _service(documents=[document])
    helper = servicetest.run(service, {**REQUEST, 'overwrite': True})

    [result] = helper.results
    assert (result['drafted'], result['kept'], result['skipped']) == (1, 1, 0)
    # Only the machine sentence's anchor is deleted.
    assert service.client.payloads('tokens.bulk_delete') == [['n1']]
    assert result['notice'] == {'level': 'success', 'title': 'Drafted 1 sentence',
                                'message': 'Kept 1 verified sentence.'}
    # And only the machine sentence was sent to the model.
    assert len(service.model.calls) == 1
    assert 'Sentence 1:' in service.model.prompts[0]


def test_a_constant_belongs_to_no_sentence_and_does_not_count_as_a_graph():
    """A constant's anchor is a zero-width token at offset 0, which falls
    inside the first sentence. Reading it as one of that sentence's nodes would
    make every document with a document-level triple look already drafted."""
    doc = _document(
        node_tokens=[('n1', 0, 0)],
        concept_spans=[{'id': 'sp1', 'tokens': ['n1'], 'value': 'author',
                        'metadata': {'umr': {'var': 'author', 'constant': True}}}])
    service = _service(documents=[doc])
    helper = servicetest.run(service, REQUEST)

    [result] = helper.results
    assert (result['drafted'], result['skipped']) == (1, 0)


def test_a_document_that_moved_while_the_model_ran_is_not_written_to():
    """The plan points at ids read before the model ran, and was allowed to
    replace the graphs that were there then. Both are out of date if someone
    edited the document meanwhile."""
    service = _service(documents=[_document(version=7), _document(version=8)])
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == ['The document changed while this run was working. Run it again.']
    assert service.client.writes == []
    assert service.client.kinds[-1] == 'unlock'


# --- what the model gets wrong -----------------------------------------------

@pytest.mark.parametrize('reply,fragment', [
    ('I am sorry, I cannot help with that.', 'opening bracket of the root node'),
    ('(v1 / bark-01 :ARG0 (v2 / dog)', 'without closing'),
    ('(v1 / )', 'Expected a concept'),
    ('(v1 / bark-01 :ARG0 s9x9)\n\n# alignment:\nv1: 1-1\n', 'No such node is defined'),
])
def test_a_malformed_answer_is_counted_and_named_rather_than_written(reply, fragment):
    service = _service(model=_Model([reply]))
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == [], 'a bad sentence is a count, not a failed request'
    [result] = helper.results
    assert (result['drafted'], result['failed']) == (0, 1)
    assert result['sentences_failed'][0]['sentence'] == 1
    assert fragment in result['sentences_failed'][0]['reason']
    assert result['notice']['level'] == 'warning'
    assert result['notice']['title'] == 'Nothing drafted'
    assert service.client.writes == []


def test_a_reply_cut_off_at_the_token_limit_is_a_failure_not_a_half_graph():
    service = _service(model=_Model([GOOD_REPLY], truncated=True))
    helper = servicetest.run(service, REQUEST)

    [result] = helper.results
    assert result['drafted'] == 0 and result['failed'] == 1
    assert 'cut off' in result['sentences_failed'][0]['reason']
    assert service.client.writes == []


def test_one_bad_sentence_does_not_throw_away_the_good_ones():
    doc = _document(body='The dog barks\nIt runs\n',
                    sentences=[(0, 14), (14, 22)],
                    words=WORDS + [(14, 16), (17, 21)])
    service = _service(documents=[doc], model=_Model(['not a graph', GOOD_REPLY]))
    helper = servicetest.run(service, REQUEST)

    [result] = helper.results
    assert (result['drafted'], result['failed']) == (1, 1)
    assert result['notice']['level'] == 'success'
    assert result['notice']['title'] == 'Drafted 1 sentence'
    assert 'Failed 1 sentence' in result['notice']['message']
    assert len(_ops(service.client, 'spans.bulk_create')) == 3


def test_a_provider_key_never_reaches_the_person_who_asked():
    """A provider quotes the key it refused back in its own error text, and
    that text is reported against the sentence that failed."""
    error = RuntimeError(f'AuthenticationError: invalid api key {KEY} at '
                         f'https://api.openai.com/v1/chat/completions')
    service = _service(model=_Model(error=error))
    helper = servicetest.run(service, REQUEST)

    [result] = helper.results
    reason = result['sentences_failed'][0]['reason']
    assert KEY not in reason and 'api.openai.com' not in reason
    assert KEY not in result['notice']['message']
    assert all(KEY not in text for text in helper.errors)
    assert all(KEY not in msg for msg in helper.messages)


# --- the lock ----------------------------------------------------------------

def test_the_lock_is_taken_around_the_writes_and_released_after_them():
    service = _service()
    servicetest.run(service, REQUEST)

    kinds = service.client.kinds
    assert kinds.count('lock') == 1 and kinds.count('unlock') == 1
    # The model runs OUTSIDE the lock: holding a document for minutes of
    # provider time would block the annotator for no reason, which is what
    # check_unchanged covers instead.
    assert kinds.index('read') < kinds.index('lock')
    writes = [i for i, k in enumerate(kinds) if k.startswith(('tokens.', 'spans.', 'relations.'))]
    assert kinds.index('lock') < min(writes)
    assert kinds.index('unlock') > max(writes)


def test_the_lock_is_released_when_a_write_fails():
    service = _service(fails={'spans.bulk_create': PlaidAPIError(
        'HTTP 400 Span value is required at http://plaid.internal:8085/api/v1/spans/bulk',
        status=400, url='http://plaid.internal:8085/api/v1/spans/bulk', method='POST')})
    helper = servicetest.run(service, REQUEST)

    assert service.client.kinds[-1] == 'unlock'
    assert helper.errors == ['UMR drafting: HTTP 400 Span value is required']
    assert 'plaid.internal' not in helper.errors[0]
    assert service.client.payloads('relations.bulk_create') == []


def test_a_document_someone_else_holds_is_refused_without_writing():
    service = _service()
    said = ("Document d1 is locked by ann@x.com (likely being edited); "
            "try again once they're done.")

    def locked(document_id):
        raise PlaidAPIError(said, status=423, url='http://plaid.internal:8085/api/v1/lock')

    service.client.documents.locked = locked
    helper = servicetest.run(service, REQUEST)

    assert helper.errors == [f'UMR drafting: {said}']
    assert service.client.writes == []


def test_a_project_without_the_umr_layers_is_refused_once_and_named():
    doc = _document()
    doc['text_layers'][0]['token_layers'][2]['config'] = {}       # the node layer's flag
    service = _service(documents=[doc])
    helper = servicetest.run(service, REQUEST)

    assert len(helper.errors) == 1
    assert 'not set up for UMR' in helper.errors[0]
    assert 'node layer' in helper.errors[0]
    assert service.client.writes == []


# --- progress and stopping ---------------------------------------------------

def test_every_phase_says_what_it_is_doing_and_the_bar_only_moves_forward():
    service = _service()
    helper = servicetest.run(service, REQUEST)

    assert [msg for _, msg in helper.beats] == [
        'Reading the document…',
        'Reading the project…',
        'Reading the document…',
        'Drafting sentence 1 (1 of 1)…',
        'Writing 1 graphs…',
        'Writing 3 anchors…',
        'Writing 3 nodes…',
        'Writing 2 relations…',
        'Drafted 1 sentence',
    ]
    percents = [pct for pct, _ in helper.beats]
    assert percents == sorted(percents), percents
    assert percents[-1] == 100


@pytest.mark.parametrize('stop_at', ['Reading the document…', 'Drafting sentence 1 (1 of 1)…'])
def test_a_stop_before_the_writes_ends_the_run_with_one_report(stop_at):
    service = _service()
    helper = servicetest.Helper(stop_when=lambda pct, msg: msg == stop_at)
    servicetest.run(service, REQUEST, helper)

    assert helper.reports == [('completed', {'stopped': True})]
    assert service.client.writes == []


def test_a_stop_that_lands_in_the_writes_is_ignored_and_the_run_finishes():
    """A stop with nothing left to prevent is silently ignored: the write phase
    and the final report are one critical block, so a stop half way through
    finishes the graph rather than leaving anchors with no nodes."""
    service = _service()
    helper = servicetest.Helper(stop_when=lambda pct, msg: msg.startswith('Writing 3 anchors'))
    servicetest.run(service, REQUEST, helper)

    assert helper.cancelled, 'the stop never landed, so this proves nothing'
    [result] = helper.results
    assert result['status'] == 'success' and 'stopped' not in result
    assert service.client.payloads('relations.bulk_create') != []
    assert service.client.kinds[-1] == 'unlock'


# --- reading the reply -------------------------------------------------------
# The notation itself is `plaid_client.workflows.umr.penman`, tested there and
# held to the app's reader by plaid-agent's mirror test. What is this service's
# own is splitting a reply in two and reading the alignment block.


def test_a_reply_wrapped_in_a_code_fence_is_still_read():
    graph_text, alignment = umr.split_reply(
        '```\n(v1 / bark-01)\n```\n# alignment:\nv1: 1-1\n')
    assert umr.parse_penman(graph_text).root == 'v1'
    assert umr.parse_alignment(alignment) == {'v1': [(1, 1)]}


def test_an_alignment_line_that_cannot_be_read_leaves_its_node_unaligned():
    assert umr.parse_alignment('v1: 1-1\nv2: ???\nv3: 0-0\nv4 :2-3') == {
        'v1': [(1, 1)], 'v2': [], 'v3': [], 'v4': [(2, 3)]}
