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
import types

import pytest
from plaid_client import testing as servicetest
from plaid_client.http import PlaidAPIError
from plaid_client.services import ServiceCancelled
from plaid_client.workflows.llm import Reply

SERVICES = pathlib.Path(__file__).resolve().parent.parent

umr = servicetest.load_service(SERVICES / 'umr_draft_llm.py')
from plaid_client.service import service_version  # noqa: E402

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

    def __init__(self, replies=None, error=None, truncated=False, during=None):
        self.calls = []          # (system, user)
        #: called with ``should_stop`` while the call "waits", as a provider
        #: that has not answered yet
        self._during = during
        self._replies = list(replies if replies is not None else [GOOD_REPLY])
        self._error = error
        self._truncated = truncated

    def complete(self, system, user, should_stop=None):
        self.calls.append((system, user))
        self.should_stop = should_stop
        if self._during:
            self._during(should_stop)
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
              concept_spans=(), relations=(), doc_relations=(), gloss_spans=None,
              version=7):
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
             'config': {'umr': {'documentGraph': True}}, 'relations': list(doc_relations)},
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
    # Each node takes its own anchor, by a ref to the id the anchor op makes:
    # anchors, nodes and relations go in one batch.
    assert [n['tokens'] for n in nodes] == [[{'$ref': 0, 'index': k}] for k in range(3)]

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
        (':ARG0', {'$ref': 1, 'index': 0}, {'$ref': 1, 'index': 1}, {'order': 0}),
        (':temporal', {'$ref': 1, 'index': 0}, {'$ref': 1, 'index': 2}, {'order': 2}),
    ]
    assert {r['relation_layer_id'] for r in relations} == {'relL'}

    # Everything it writes is machine-made and nobody has vouched for it.
    for op in nodes + relations:
        meta = op['metadata']
        assert meta['prov'] == 'inferred'
        assert meta['provSource'] == SOURCE
        assert 'provConfirmed' not in meta

    # Each item records what was drafted, so a node accepted as drafted and
    # one corrected before it was verified stay distinguishable
    # (provDetail.value, the provenance convention's prediction extra).
    # The model and this file's version come first (the core manual, "Provenance").
    base = {'model': 'openai/gpt-4o-mini', 'version': service_version(umr.__file__), 'language': 'English'}
    assert [n['metadata']['provDetail'] for n in nodes] == [
        {**base, 'value': 'bark-01', 'attrs': [{'rel': ':aspect', 'value': 'process'}]},
        {**base, 'value': 'dog', 'attrs': [{'rel': ':refer-number', 'value': 'singular'}]},
        {**base, 'value': 'now'},
    ]
    assert [r['metadata']['provDetail'] for r in relations] == [
        {**base, 'value': ':ARG0'}, {**base, 'value': ':temporal'}]

    assert service.client.operations == ['UMR draft of sentence 1']


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
    assert node['tokens'] == [{'$ref': 0, 'index': 0}, {'$ref': 0, 'index': 1}]


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


def test_a_project_that_cannot_be_read_fails_the_run_without_asking_the_model():
    # R1-DEBT-CORE-16, the same read as the skeleton's: a failed read of the
    # project is not a project with no language.
    from plaid_client.http import PlaidAPIError
    service = _service()

    def refuse(*args, **kwargs):
        raise PlaidAPIError('HTTP 403 Forbidden', status=403)

    service.client.projects.get = refuse
    helper = servicetest.run(service, REQUEST)

    assert helper.results == [] and helper.errors
    assert service.client.writes == []
    assert service.model.calls == []


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
                                'message': 'Kept 1 sentence a person had worked on.'}


MACHINE = {'prov': 'inferred', 'provSource': SOURCE}


def _two_drafted_sentences(relations=(), doc_relations=()):
    """Two sentences, both drafted by the service: s1d on "The" and s2c on
    "The" of the second."""
    return _document(
        body='The dog barks\nThe cat sleeps\n', sentences=((0, 14), (14, 30)),
        words=[(0, 3), (4, 7), (8, 13), (14, 17), (18, 21), (22, 28)],
        node_tokens=[('n1', 0, 3), ('n1b', 4, 7), ('n2', 14, 17)],
        concept_spans=[
            {'id': 'sp1', 'tokens': ['n1'], 'value': 'dog',
             'metadata': {'umr': {'var': 's1d', 'attrs': []}, **MACHINE}},
            {'id': 'sp1b', 'tokens': ['n1b'], 'value': 'bark-01',
             'metadata': {'umr': {'var': 's1b', 'attrs': []}, **MACHINE}},
            {'id': 'sp2', 'tokens': ['n2'], 'value': 'cat',
             'metadata': {'umr': {'var': 's2c', 'attrs': []}, **MACHINE}},
        ], relations=relations, doc_relations=doc_relations)


# Redrafting a sentence deletes its anchors, which cascades every edge and
# document-level triple on its nodes, so those are protected as the nodes are,
# and so is anything another sentence's block writes.
@pytest.mark.parametrize('relations, doc_relations, why', [
    ([{'id': 'r1', 'source': 'sp1b', 'target': 'sp1', 'value': ':ARG0',
       'metadata': {'umr': {'order': 0}, **MACHINE, 'provConfirmed': True}}], [],
     'a confirmed edge'),
    ([{'id': 'r1', 'source': 'sp1b', 'target': 'sp1', 'value': ':ARG0',
       'metadata': {'umr': {'order': 0}}}], [], 'a hand-made edge'),
    ([], [{'id': 't1', 'source': 'sp2', 'target': 'sp1', 'value': ':same-entity',
           'metadata': {'umr': {'group': 'coref'}, **MACHINE}}],
     "a triple sentence 2's block writes"),
    # A person's triple is still sentence 2's work, not sentence 1's: sentence
    # 1 is kept as linked to, and nothing says a person worked on it.
    ([], [{'id': 't1', 'source': 'sp2', 'target': 'sp1', 'value': ':same-entity',
           'metadata': {'umr': {'group': 'coref'}}}],
     "a person's triple sentence 2's block writes"),
    ([{'id': 'r1', 'source': 'sp2', 'target': 'sp1', 'value': ':ARG1',
       'metadata': {'umr': {'order': 0}, **MACHINE}}], [],
     "an edge from sentence 2's node"),
])
def test_overwrite_keeps_a_sentence_whose_edges_or_triples_it_may_not_delete(
        relations, doc_relations, why):
    service = _service(documents=[_two_drafted_sentences(relations, doc_relations)])
    helper = servicetest.run(service, {**REQUEST, 'overwrite': True, 'scope': 'sentence',
                                       'sentence': 1})

    [result] = helper.results
    # A person's work is counted as that. A machine link from another
    # sentence is counted apart, and the notice does not claim a person.
    by_link = "sentence 2" in why
    assert (result['drafted'], result['kept'], result['linked']) == (
        (0, 0, 1) if by_link else (0, 1, 0)), why
    assert result['notice']['message'] == (
        'Kept 1 sentence that another sentence links to.' if by_link
        else 'Kept 1 sentence a person had worked on.'), why
    assert service.client.writes == [], f'{why} is not deleted'


@pytest.mark.parametrize('node_metadata, why', [
    ({}, 'hand-made'),
    ({'prov': 'inferred', 'provSource': SOURCE, 'provConfirmed': True}, 'verified'),
])
def test_without_overwrite_a_persons_sentence_is_kept_and_overwrite_is_not_offered(
        node_metadata, why):
    """Overwrite would refuse this sentence too, so the notice must not
    recommend it: the sentence is counted as kept in both modes."""
    service = _service(documents=[_drafted_document(node_metadata)])
    [result] = servicetest.run(service, REQUEST).results

    assert (result['drafted'], result['skipped'], result['kept']) == (0, 0, 1), why
    assert result['notice'] == {'level': 'warning', 'title': 'Document not modified',
                                'message': 'Kept 1 sentence a person had worked on.'}


def test_without_overwrite_the_hint_counts_only_the_sentences_it_would_redraft():
    document = _document(
        body='The dog barks\nThe cat sleeps\n', sentences=((0, 14), (14, 30)),
        words=[(0, 3), (4, 7), (8, 13), (14, 17), (18, 21), (22, 28)],
        node_tokens=[('n1', 0, 3), ('n2', 14, 17)],
        concept_spans=[
            {'id': 'sp1', 'tokens': ['n1'], 'value': 'dog',
             'metadata': {'umr': {'var': 's1d', 'attrs': []}, **MACHINE}},
            {'id': 'sp2', 'tokens': ['n2'], 'value': 'cat',
             'metadata': {'umr': {'var': 's2c', 'attrs': []}}},
        ])
    service = _service(documents=[document])
    [result] = servicetest.run(service, REQUEST).results

    assert (result['drafted'], result['skipped'], result['kept']) == (0, 1, 1)
    assert result['notice']['message'] == (
        "1 sentence already has a graph. Enable 'Overwrite existing graphs' to draft over it. "
        'Kept 1 sentence a person had worked on.')


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
                                'message': 'Kept 1 sentence a person had worked on.'}
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
    ('(v1 / bark-01 :ARG0 s9x9)\n\n# alignment:\nv1: 1-1\n', "Variable 's9x9' is not defined."),
    # An uppercase letter makes `s1Y` a value, not a variable, as the app
    # reads it, so the edge would land as an attribute.
    ('(v1 / bark-01 :ARG0 s1Y)\n\n# alignment:\nv1: 3-3\n', ':ARG0 takes a node'),
    ('(v1 / bark-01 :actor "dog")\n\n# alignment:\nv1: 3-3\n', ':actor takes a node'),
    ('(v1 / dog :ARG0-of barking)\n\n# alignment:\nv1: 2-2\n', ':ARG0-of takes a node'),
    # A modifier is a relation too: the app refuses a value under any role it
    # does not type as an attribute.
    ('(v1 / bark-01 :manner s1Y)\n\n# alignment:\nv1: 3-3\n', ':manner takes a node'),
    ('(v1 / bark-01 :temporal s1Y)\n\n# alignment:\nv1: 3-3\n', ':temporal takes a node'),
    ('(v1 / dog :possessor s1Y)\n\n# alignment:\nv1: 2-2\n', ':possessor takes a node'),
    # A relation UMR does not have is refused as the app and the assistant
    # refuse it, edge or value, and the reason names the likeliest one meant.
    ('(v1 / dog :poss (v2 / person))\n\n# alignment:\nv1: 2-2\nv2: 0-0\n',
     "Unknown relation ':poss': UMR has no such relation. Did you mean :possessor?"),
    ('(v1 / person :poss-of (v2 / dog))\n\n# alignment:\nv1: 0-0\nv2: 2-2\n',
     "Unknown relation ':poss-of'"),
    ('(v1 / bark-01 :polarityy -)\n\n# alignment:\nv1: 3-3\n',
     "Unknown relation ':polarityy'"),
    ('(v1 / dog :refer-numbr singular)\n\n# alignment:\nv1: 2-2\n',
     'Did you mean :refer-number?'),
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
    assert result['notice']['message'] == (
        "Failed to draft sentence 1: Expected the opening bracket of the root node, "
        "found 'not a graph'.")
    assert result['notice']['sticky'] is True
    assert len(_ops(service.client, 'spans.bulk_create')) == 3
    assert service.client.operations == ['UMR draft of sentence 2']


def _sentences_document(n):
    words = ['The', 'dog', 'barks']
    body, sentences, spans = '', [], []
    for _ in range(n):
        start = len(body)
        for w in words:
            spans.append((len(body), len(body) + len(w)))
            body += w + ' '
        body = body[:-1] + '\n'
        sentences.append((start, len(body)))
    return _document(body=body, sentences=sentences, words=spans)


def test_the_notice_names_every_failed_sentence_with_its_own_reason_and_stays():
    """A whole-document run used to report one reason for all its failures,
    in a toast gone in four seconds. Each sentence is named now, sentences
    that failed alike together, and the notice stays until dismissed."""
    two_graphs = '(v1 / bark-01)\n(v2 / dog)\n\n# alignment:\nv1: 3-3\nv2: 2-2\n'
    size = '(v1 / dog :size small)\n\n# alignment:\nv1: 2-2\n'
    replies = [GOOD_REPLY, two_graphs, size, two_graphs]
    service = _service(documents=[_sentences_document(4)], model=_Model(replies))
    helper = servicetest.run(service, REQUEST)

    [result] = helper.results
    assert (result['drafted'], result['failed']) == (1, 3)
    assert [f['sentence'] for f in result['sentences_failed']] == [2, 3, 4]
    assert result['notice'] == {
        'level': 'success', 'title': 'Drafted 1 sentence', 'sticky': True,
        'message': ("Failed to draft 3 sentences. Sentences 2 and 4: Unexpected content "
                    "after the topmost closing bracket: '(v2 / dog)'. Sentence 3: v1 :size "
                    "takes a node, not the value small.")}


def test_every_failure_reason_reaches_the_operators_log(capsys):
    service = _service(model=_Model(['(v1 / dog :size small)\n\n# alignment:\nv1: 2-2\n']))
    servicetest.run(service, REQUEST)

    log = capsys.readouterr().out
    assert 'Sentence 1 not drafted: v1 :size takes a node, not the value small.' in log
    # And the reply itself, which is what anyone improving the prompt needs.
    assert '(v1 / dog :size small)' in log


def test_a_run_that_drafts_several_sentences_is_counted_in_history():
    service = _service(documents=[_sentences_document(2)])
    servicetest.run(service, REQUEST)
    assert service.client.operations == ['UMR draft (2 sentences)']


@pytest.mark.parametrize('reply', [
    # The model names a variable only its alignment block defines.
    '(v1 / bark-01 :actor p)\n\n# alignment:\nv1: 3-3\np: 2-2\n',
    # Or one in its own naming that nothing defines.
    '(v1 / bark-01 :actor p)\n\n# alignment:\nv1: 3-3\n',
])
def test_a_variable_the_reply_never_defines_is_named_as_that(reply):
    service = _service(model=_Model([reply]))
    [result] = servicetest.run(service, REQUEST).results
    assert result['sentences_failed'][0]['reason'] == 'v1 :actor names p, which no node defines.'


def _asked_by_second(client):
    """The client reads the requester's display name, as a service does."""
    client.users = types.SimpleNamespace(get=lambda uid: {'id': uid, 'display_name': 'second'})
    return client


def test_the_run_names_who_asked_in_history_and_on_what_it_drafts():
    """umr-collab-service-requester: the service writes with its operator's
    token, so the requester core sent is named in the History label and in
    every stamp's provDetail."""
    service = _service()
    _asked_by_second(service.client)
    servicetest.run(service, {**REQUEST, 'requester_id': 'second@x.com'})

    assert service.client.operations == ['UMR draft of sentence 1, requested by second']
    nodes = _ops(service.client, 'spans.bulk_create')
    [relations] = service.client.payloads('relations.bulk_create')
    for op in nodes + relations:
        assert op['metadata']['provDetail']['requestedBy'] == 'second@x.com'


def test_a_reply_written_one_block_per_node_is_joined_and_drafted():
    """A flat reply, the shape 4 of 13 real gpt-oss-120b replies took, is one
    graph in another layout. It is joined where each variable is first used
    and drafted like any other, with no second model call."""
    reply = ('(v1 / bark-01\n   :ARG0 v2\n   :aspect process\n   :temporal v3)\n'
             '(v2 / dog\n   :refer-number singular)\n(v3 / now)\n\n'
             '# alignment:\nv1: 3-3\nv2: 2-2\nv3: 0-0\n')
    model = _Model([reply])
    service = _service(model=model)
    [result] = servicetest.run(service, REQUEST).results

    assert (result['drafted'], result['failed']) == (1, 0)
    assert len(model.calls) == 1
    nodes = _ops(service.client, 'spans.bulk_create')
    assert [n['value'] for n in nodes] == ['bark-01', 'dog', 'now']
    assert nodes[0]['metadata']['umr']['attrs'] == [
        {'rel': ':aspect', 'value': 'process', 'order': 1}]
    [relations] = service.client.payloads('relations.bulk_create')
    assert [(r['value'], r['metadata']['umr']) for r in relations] == [
        (':ARG0', {'order': 0}), (':temporal', {'order': 2})]


@pytest.mark.parametrize('reply, reason', [
    # A block no earlier block uses is a second graph, not part of this one.
    ('(v1 / bark-01 :ARG0 v2)\n(v2 / dog)\n(v3 / cat :ARG0-of v1)\n\n'
     '# alignment:\nv1: 3-3\nv2: 2-2\nv3: 0-0\n',
     "Unexpected content after the topmost closing bracket: '(v3 / cat :ARG0-of v1)'."),
    # Joined, and still refused for a relation UMR does not have.
    ('(v1 / bark-01 :ARG0 v2)\n(v2 / dog :location v3)\n(v3 / yard)\n\n'
     '# alignment:\nv1: 3-3\nv2: 2-2\nv3: 0-0\n',
     "Unknown relation ':location'"),
    # Joined, and still refused for a variable nothing defines.
    ('(v1 / bark-01 :ARG0 v2)\n(v2 / dog :possessor p)\n\n# alignment:\nv1: 3-3\nv2: 2-2\n'
     'p: 1-1\n',
     'v2 :possessor names p, which no node defines.'),
])
def test_a_flat_reply_that_is_wrong_once_joined_is_still_refused(reply, reason):
    service = _service(model=_Model([reply]))
    [result] = servicetest.run(service, REQUEST).results
    assert (result['drafted'], result['failed']) == (0, 1)
    assert reason in result['sentences_failed'][0]['reason']
    assert service.client.writes == []


def test_the_prompt_teaches_only_values_the_validator_takes():
    """Every closed attribute set in the prompt is the inventory's, so the
    model is never taught a value the canvas marks as wrong."""
    from plaid_client.workflows.umr.inventory import ATTRIBUTE_VALUES
    for rel in (':aspect', ':modal-strength', ':refer-person', ':refer-number'):
        assert ' '.join(ATTRIBUTE_VALUES[rel]) in umr.SYSTEM_PROMPT, rel
    for wrong in ('nonsingular', 'iterative', '1st-inclusive', '1st-exclusive'):
        assert wrong not in umr.SYSTEM_PROMPT
    assert '4th' in umr.SYSTEM_PROMPT


@pytest.mark.parametrize('rel, value', [
    (':refer-number', 'nonsingular'), (':aspect', 'iterative'), (':refer-person', '1st-inclusive'),
])
def test_a_value_outside_an_attributes_set_is_refused(rel, value):
    reply = f'(v1 / dog {rel} {value})\n\n# alignment:\nv1: 2-2\n'
    service = _service(model=_Model([reply]))
    [result] = servicetest.run(service, REQUEST).results
    assert result['sentences_failed'][0]['reason'] == f'{value} is not a value of {rel}.'
    assert service.client.writes == []


def test_a_reply_never_writes_the_sentences_reserved_variable_or_one_twice():
    """`s1s0` names sentence 1's document graph, and the editor refuses it.
    The draft re-generates every variable (s + sentence + letter, then a
    counter from 2), so a reply's own `s1s0` is renamed, and a reply that
    defines one variable twice is refused by the reader."""
    reply = ('(s1s0 / bark-01 :ARG0 (s1s / dog) :ARG1 (v3 / sound))'
             '\n\n# alignment:\ns1s0: 3-3\ns1s: 2-2\nv3: 0-0\n')
    service = _service(model=_Model([reply]))
    servicetest.run(service, REQUEST)
    written = [n['metadata']['umr']['var'] for n in _ops(service.client, 'spans.bulk_create')]
    assert written == ['s1b', 's1d', 's1s']
    assert len(set(written)) == len(written)

    twice = '(v1 / bark-01 :ARG0 (v1 / dog))\n\n# alignment:\nv1: 3-3\n'
    service = _service(model=_Model([twice]))
    [result] = servicetest.run(service, REQUEST).results
    assert result['failed'] == 1 and service.client.writes == []
    assert 'used twice' in result['sentences_failed'][0]['reason']


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
    said = "This document is being edited by ann@x.com. Try again once they're done."

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
    assert 'This project is not fully set up.' in helper.errors[0]
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
        'Writing 1 graph…',
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


def test_a_stop_while_the_model_is_silent_ends_the_run():
    """The model call is the one long step, and a provider that never answers
    must not hold the document: the stop is read while the call waits
    (``ChatModel.complete`` polls ``should_stop``), not at the next beat."""
    helper = servicetest.Helper()

    def silent_provider(should_stop):
        helper.stop()
        assert should_stop is not None and should_stop()
        raise ServiceCancelled('The requester stopped this request')

    service = _service(model=_Model(during=silent_provider))
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


def test_a_roleset_that_takes_a_value_as_its_argument_is_drafted():
    reply = '(v1 / have-polarity-91 :ARG1 (v2 / dog) :ARG2 -)\n\n# alignment:\nv1: 0-0\nv2: 2-2\n'
    service = _service(model=_Model([reply]))
    [result] = servicetest.run(service, REQUEST).results
    assert (result['drafted'], result['failed']) == (1, 0)


def test_a_numbered_op_and_an_inverse_role_are_known_relations():
    reply = ('(v1 / and :op1 (v2 / dog) :op3 (v3 / cat :ARG0-of (v4 / bark-01)))'
             '\n\n# alignment:\nv1: 0-0\nv2: 2-2\nv3: 0-0\nv4: 3-3\n')
    service = _service(model=_Model([reply]))
    [result] = servicetest.run(service, REQUEST).results
    assert (result['drafted'], result['failed']) == (1, 0)


def test_the_draft_refuses_a_value_by_the_shared_inventory():
    """The draft's node-only roles are the inventory's in plaid_client, which
    ``test_umr_inventory_mirror.py`` holds to the app's inventory.js."""
    from plaid_client.workflows.umr import inventory
    assert umr.edge_only is inventory.edge_only


# --- a model that does not answer --------------------------------------------

class _Scripted(_Model):
    """One outcome per call, in order: a reply's text, or an exception."""

    def __init__(self, outcomes):
        super().__init__()
        self._outcomes = list(outcomes)

    def complete(self, system, user, should_stop=None):
        self.calls.append((system, user))
        outcome = self._outcomes[len(self.calls) - 1]
        if isinstance(outcome, BaseException):
            raise outcome
        return Reply(text=outcome)


def _timeout():
    from plaid_client.workflows.llm import ModelTimeout
    return ModelTimeout('The model did not answer within 120 seconds.')


def test_a_run_ends_after_two_sentences_in_a_row_get_no_answer():
    """With the model down, a 40-sentence draft used to try every sentence,
    two full deadlines each, with the document read-only for hours. It stops
    after two sentences in a row, names them, and writes what it drafted."""
    service = _service(documents=[_sentences_document(6)],
                       model=_Scripted([GOOD_REPLY, _timeout(), _timeout(), GOOD_REPLY]))
    helper = servicetest.run(service, REQUEST)

    assert len(service.model.calls) == 3
    [result] = helper.results
    assert (result['drafted'], result['failed']) == (1, 2)
    assert [f['sentence'] for f in result['sentences_failed']] == [2, 3]
    assert result['sentences_not_drafted'] == [4, 5, 6]
    assert result['notice'] == {
        'level': 'success', 'title': 'Drafted 1 sentence', 'sticky': True,
        'message': ('Failed to draft 2 sentences. Sentences 2 and 3: The model did not answer '
                    'within 120 seconds. The model did not answer 2 sentences in a row, so the '
                    'run stopped. 3 sentences were not drafted.')}
    assert service.client.operations == ['UMR draft of sentence 1']


def test_a_run_with_the_model_down_from_the_start_drafts_nothing_and_says_why():
    service = _service(documents=[_sentences_document(3)],
                       model=_Scripted([_timeout(), _timeout(), GOOD_REPLY]))
    helper = servicetest.run(service, REQUEST)

    [result] = helper.results
    assert result['notice']['title'] == 'Nothing drafted'
    assert result['notice']['message'].endswith(
        'so the run stopped. 1 sentence was not drafted.')
    assert service.client.writes == []


def test_one_silent_sentence_between_answers_does_not_end_the_run():
    """Only sentences IN A ROW count: a reply, a bad one included, starts the
    count again."""
    service = _service(documents=[_sentences_document(5)],
                       model=_Scripted([_timeout(), 'not a graph', _timeout(), GOOD_REPLY,
                                        _timeout()]))
    helper = servicetest.run(service, REQUEST)

    assert len(service.model.calls) == 5
    [result] = helper.results
    assert result['sentences_not_drafted'] == []
    assert 'run stopped' not in result['notice']['message']


def test_an_error_the_model_answered_with_does_not_end_the_run():
    """A refused request is an answer: the next sentence may well get a reply."""
    boom = RuntimeError('400 bad request')
    service = _service(documents=[_sentences_document(3)],
                       model=_Scripted([boom, boom, GOOD_REPLY]))
    helper = servicetest.run(service, REQUEST)
    [result] = helper.results
    assert (result['drafted'], result['failed']) == (1, 2)


def test_a_run_whose_last_two_sentences_get_no_answer_did_not_stop():
    """Nothing was left to ask, so the run finished: the notice names the two
    sentences with their reason and does not say the run stopped."""
    service = _service(documents=[_sentences_document(3)],
                       model=_Scripted([GOOD_REPLY, _timeout(), _timeout()]))
    helper = servicetest.run(service, REQUEST)

    [result] = helper.results
    assert result['sentences_not_drafted'] == []
    assert result['notice']['message'] == (
        'Failed to draft 2 sentences. Sentences 2 and 3: The model did not answer within '
        '120 seconds.')
