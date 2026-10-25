"""spans/relations/tokens bulk_update (the request is in the shared request
table, ``test_requests.py``): the versions of EVERY document the update
touched come back in X-Document-Versions. A bulk update may reach several documents of one
project, and a client that learned only the first one's version writes the
rest with a stale one, which strict mode then refuses.
"""

import json

from plaid_client.client import PlaidClient
from plaid_client.testing import recording_session


def make_client(versions):
    client = PlaidClient('http://plaid.test', 'tok')
    client.session = recording_session([(200, {'count': 2}, {'X-Document-Versions': json.dumps(versions)})])
    return client


def test_every_document_in_the_header_is_learned_not_just_the_first():
    client = make_client({'d1': 8, 'd2': 3})
    client.spans.bulk_update([{'id': 's1', 'value': 'X'}, {'id': 's2', 'value': 'Y'}])
    assert client.document_versions == {'d1': 8, 'd2': 3}


def test_relations_and_tokens_learn_the_versions_too():
    client = make_client({'d1': 9, 'd2': 4})
    client.relations.bulk_update([{'id': 'r1', 'value': 'nsubj'}])
    client.tokens.bulk_update([{'id': 't1', 'metadata': [{'op': 'set', 'path': ['form'], 'value': 'cd'}]}])
    assert client.document_versions == {'d1': 9, 'd2': 4}
