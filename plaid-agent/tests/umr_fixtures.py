"""A small UMR project and document in the live API's shape.

English, two sentences. The first carries a graph with an attribute on each of
its two nodes; the second carries a graph of its own and a coreference triple
back into the first, so the document graph and the re-entrancy rules are
exercised by every test that reads the fixture rather than by one test that
remembers to.
"""

from core.fake_client import BaseFakeClient, ExtFakeClient

PID = 'mp1'
TEXT_LAYER, SENT_LAYER, WORD_LAYER = 'm-tl', 'm-sent', 'm-word'
GLOSS_LAYER = 'm-gloss'
NODE_LAYER, CONCEPT_LAYER, RELATION_LAYER, DOC_LAYER = 'm-node', 'm-concept', 'm-rel', 'm-doc'
TEXT_ID = 'm-text'


def project_raw():
    return {
        'id': PID, 'name': 'Sample',
        'config': {'umr': {'language': 'en'}},
        'text_layers': [{
            'id': TEXT_LAYER, 'name': 'Text', 'config': {'plaid': {'role': 'baseline'}},
            'token_layers': [
                {'id': SENT_LAYER, 'name': 'Sentences', 'config': {'plaid': {'role': 'sentence'}},
                 'span_layers': []},
                {'id': WORD_LAYER, 'name': 'Words', 'config': {'plaid': {'role': 'word'}},
                 'span_layers': [
                     {'id': GLOSS_LAYER, 'name': 'Word Gloss',
                      'config': {'igt': {'scope': 'word', 'lang': 'en'}}}]},
                {'id': NODE_LAYER, 'name': 'UMR nodes', 'config': {'umr': {'nodes': True}},
                 'span_layers': [
                     {'id': CONCEPT_LAYER, 'name': 'UMR concepts',
                      'config': {'umr': {'concepts': True}},
                      'relation_layers': [
                          {'id': RELATION_LAYER, 'name': 'UMR relations',
                           'config': {'umr': {'relations': True}}},
                          {'id': DOC_LAYER, 'name': 'UMR document graph',
                           'config': {'umr': {'documentGraph': True}}}]}]},
            ]}],
    }


# The dog barked .   -> 0-16, the sentence taking the newline after it (0-17)
# It ran away .      -> 17-30, the sentence 17-31
BODY = 'The dog barked .\nIt ran away .\n'


def document_raw():
    """Two sentences, each with a graph, and one coreference triple between
    them. Sentence 1's nodes carry an attribute each; sentence 2's do not,
    which is what a "what is unfinished" read has to find."""
    return {
        'id': 'umr1', 'name': 'Story', 'version': 4, 'metadata': {'genre': 'narrative'},
        # A document read carries each layer's config exactly as a project read
        # does, which is how a reader tells the layers apart.
        'text_layers': [{
            'id': TEXT_LAYER, 'name': 'Text', 'config': {'plaid': {'role': 'baseline'}},
            'text': {'id': TEXT_ID, 'body': BODY},
            'token_layers': [
                {'id': SENT_LAYER, 'config': {'plaid': {'role': 'sentence'}}, 'tokens': [
                    {'id': 'ms-1', 'begin': 0, 'end': 17, 'metadata': {'umr': {'snt': 1}}},
                    {'id': 'ms-2', 'begin': 17, 'end': 31, 'metadata': {'umr': {'snt': 2}}}],
                 'span_layers': []},
                {'id': WORD_LAYER, 'config': {'plaid': {'role': 'word'}}, 'tokens': [
                    {'id': 'mw-1', 'begin': 0, 'end': 3},
                    {'id': 'mw-2', 'begin': 4, 'end': 7},
                    {'id': 'mw-3', 'begin': 8, 'end': 14},
                    {'id': 'mw-4', 'begin': 15, 'end': 16},
                    {'id': 'mw-5', 'begin': 17, 'end': 19},
                    {'id': 'mw-6', 'begin': 20, 'end': 23},
                    {'id': 'mw-7', 'begin': 24, 'end': 28},
                    {'id': 'mw-8', 'begin': 29, 'end': 30}],
                 'span_layers': [
                     {'id': GLOSS_LAYER, 'config': {'igt': {'scope': 'word', 'lang': 'en'}},
                      'spans': [
                         {'id': 'mg-1', 'value': 'the', 'tokens': ['mw-1']},
                         {'id': 'mg-2', 'value': 'dog', 'tokens': ['mw-2']},
                         {'id': 'mg-3', 'value': 'bark.PST', 'tokens': ['mw-3']},
                         {'id': 'mg-5', 'value': 'it', 'tokens': ['mw-5']},
                         {'id': 'mg-6', 'value': 'run.PST', 'tokens': ['mw-6']},
                         {'id': 'mg-7', 'value': 'away', 'tokens': ['mw-7']}]}]},
                {'id': NODE_LAYER, 'config': {'umr': {'nodes': True}}, 'tokens': [
                    {'id': 'mn-1', 'begin': 8, 'end': 14},   # barked
                    {'id': 'mn-2', 'begin': 4, 'end': 7},    # dog
                    {'id': 'mn-3', 'begin': 20, 'end': 23},  # ran
                    {'id': 'mn-4', 'begin': 17, 'end': 19}],  # It
                 'span_layers': [
                     {'id': CONCEPT_LAYER, 'config': {'umr': {'concepts': True}}, 'spans': [
                         {'id': 'mc-b', 'value': 'bark-01', 'tokens': ['mn-1'],
                          'metadata': {'umr': {'var': 's1b', 'root': True, 'attrs': [
                              {'rel': ':aspect', 'value': 'performance', 'order': 1}]}}},
                         {'id': 'mc-d', 'value': 'dog', 'tokens': ['mn-2'],
                          'metadata': {'umr': {'var': 's1d', 'attrs': [
                              {'rel': ':refer-number', 'value': 'singular', 'order': 0}]}}},
                         {'id': 'mc-r', 'value': 'run-01', 'tokens': ['mn-3'],
                          'metadata': {'umr': {'var': 's2r', 'root': True, 'attrs': []}}},
                         {'id': 'mc-t', 'value': 'thing', 'tokens': ['mn-4'],
                          'metadata': {'umr': {'var': 's2t', 'attrs': []}}}],
                      'relation_layers': [
                          {'id': RELATION_LAYER, 'config': {'umr': {'relations': True}},
                           'relations': [
                              {'id': 'mr-1', 'source': 'mc-b', 'target': 'mc-d', 'value': ':ARG0',
                               'metadata': {'umr': {'order': 0}}},
                              {'id': 'mr-2', 'source': 'mc-r', 'target': 'mc-t', 'value': ':ARG0',
                               'metadata': {'umr': {'order': 0}}}]},
                          {'id': DOC_LAYER, 'config': {'umr': {'documentGraph': True}},
                           'relations': [
                              {'id': 'md-1', 'source': 'mc-t', 'target': 'mc-d',
                               'value': ':same-entity',
                               'metadata': {'umr': {'group': 'coref'}}}]}]}]},
            ]}],
    }


#: The PENMAN the fixture's first sentence serializes to. Written out here so a
#: test holds the round trip to a shape a person can read, rather than to
#: whatever the serializer happens to produce.
SENTENCE_1_PENMAN = '''(s1b / bark-01
    :ARG0 (s1d / dog
        :refer-number singular)
    :aspect performance)'''

SENTENCE_2_PENMAN = '''(s2r / run-01
    :ARG0 (s2t / thing))'''


def audit_raw():
    """Two entries, naming this project's own document."""
    return [
        {'id': 'g1', 'time': '2026-09-15T18:51:47Z',
         'user': {'id': 'a@b.com', 'display_name': 'Luke G'},
         'end_time': '2026-09-15T18:51:49Z', 'message': 'Assistant: 2 concepts',
         'documents': [{'id': 'umr1', 'name': 'Story'}],
         'ops': [{'type': 'span/create', 'description': 'Create span'},
                 {'type': 'span/update', 'description': 'Update span'}]},
        {'id': 'o2', 'time': '2026-09-14T10:00:00Z',
         'user': {'id': 'x@y.z', 'display_name': 'Someone'},
         'documents': [], 'ops': [{'type': 'project/create',
                                   'description': 'Create project "Sample"'}]},
    ]


def guidelines_raw():
    """The project's annotation manual: one pinned, one not."""
    return [
        {'id': 'gl1', 'title': 'Aspect', 'pinned': True,
         'body': 'Every eventive concept carries an `:aspect`.',
         'updated_at': '2026-09-10T09:00:00Z'},
        {'id': 'gl2', 'title': 'Coreference', 'pinned': False,
         'body': 'A pronoun is a `thing` node joined to its antecedent with `:same-entity`.',
         'updated_at': '2026-09-11T09:00:00Z'},
    ]


class FakeClient(BaseFakeClient):
    """The app-neutral fake client with this app's project, document and audit
    log."""

    def __init__(self, project=None, documents=None, audit=None, guidelines=None):
        super().__init__(project or project_raw(),
                         documents if documents is not None else {'umr1': document_raw()},
                         audit if audit is not None else audit_raw(),
                         guidelines if guidelines is not None else guidelines_raw())


class ExtClient(ExtFakeClient, FakeClient):
    """This app's fake client, with the comments resource, the audit window and
    the restore dry run the newer tools call."""


def umr_client(**kw):
    return FakeClient(**kw)


def umr_ws(client=None):
    """A workspace on the fixture project, for a test that wants to call tools."""
    from plaid_agent.umr.project import load_project
    from plaid_agent.umr.tools import Workspace
    client = client or umr_client()
    return Workspace(client, load_project(client, PID))
