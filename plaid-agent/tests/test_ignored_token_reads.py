"""The search tools read a text the same with and without a token over its
punctuation (REV8-PUNCT-4, under Luke's "igt must not change because UD
annotation started"). ud's Tokenize gives punctuation a word token of its
own, which igt's ignored-tokens rule leaves out: search found such a token
(`.` answered "0 hits" and a note of documents) and sequence_search matched
an element on it, where the same text with no token there has no hit."""
import copy
import re

from fixtures import project_raw, document_raw, lexicon_raw, VOCAB
from live import live_client, seed  # noqa: F401 - fixture

from plaid_agent.igt.project import load_project
from plaid_agent.igt.workspace import Workspace
from plaid_agent.igt.toolkit import call_tool

UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')


def _without_punctuation_tokens(doc):
    """The fixture document with its word tokens over `.` taken out."""
    doc = copy.deepcopy(doc)
    for layer in doc['text_layers'][0]['token_layers']:
        layer['tokens'] = [t for t in layer['tokens'] if t['id'] not in ('w-p', 'w-p2')]
    return doc


CALLS = [
    ('search', {'pattern': '.'}),
    ('search', {'pattern': r'\p{P}', 'regex': True}),
    ('search', {'pattern': '[.a]', 'regex': True}),
    ('sequence_search', {'sequence': [{'form': 'akuna'}, {'form': r'\p{P}+'}], 'regex': True, 'adjacent': True}),
    ('sequence_search', {'sequence': [{'form': 'akuna'}, {'form': '.*'}], 'regex': True, 'adjacent': True}),
    ('sequence_search', {'sequence': [{'form': 'gam'}, {'form': 'akuna'}], 'adjacent': True}),
    ('sequence_search', {'sequence': [{'form': '.*'}, {'form': 'gam-ar'}], 'regex': True}),
]


def test_search_and_sequence_search_leave_out_ignored_tokens(live_client):
    with_tokens = seed(live_client, project_raw(), {'d1': document_raw()}, {VOCAB: lexicon_raw()},
                       name='igt-agent punctuation tokens')
    without = seed(live_client, project_raw(), {'d1': _without_punctuation_tokens(document_raw())},
                   {VOCAB: lexicon_raw()}, name='igt-agent no punctuation tokens')
    try:
        answers = []
        for s in (with_tokens, without):
            w = Workspace(s.client, load_project(s.client, s.project_id))
            answers.append([UUID.sub('ID', call_tool(w, tool, args)) for tool, args in CALLS])
        for (tool, args), a, b in zip(CALLS, *answers):
            assert a == b, (tool, args, a, b)
        assert answers[1][0].startswith('No hits'), answers[1][0]
        assert 'No sentence matches' in answers[1][3], answers[1][3]
    finally:
        with_tokens.delete()
        without.delete()
