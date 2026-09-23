"""spans/relations/tokens bulk_update: one PATCH to the /bulk path, and the
versions of EVERY document the update touched come back in
X-Document-Versions. A bulk update may reach several documents of one
project, and a client that learned only the first one's version writes the
rest with a stale one, which strict mode then refuses.
"""

import json

from plaid_client.client import PlaidClient


class FakeResponse:
    ok = True
    status_code = 200
    reason = 'OK'

    def __init__(self, versions):
        self.headers = {'content-type': 'application/json',
                        'X-Document-Versions': json.dumps(versions)}
        self.text = '{"count": 2}'

    def json(self):
        return {'count': 2}


class FakeSession:
    def __init__(self, versions):
        self.versions = versions
        self.calls = []

    def request(self, **kwargs):
        self.calls.append(kwargs)
        return FakeResponse(self.versions)


def make_client(versions):
    client = PlaidClient('http://plaid.test', 'tok')
    client.session = FakeSession(versions)
    return client


def test_a_span_bulk_update_is_one_patch_carrying_the_entries_as_sent():
    # The metadata ops pass through verbatim: keys inside a value are user data
    # and are never re-cased.
    ops = [
        {'op': 'set', 'path': ['prov'], 'value': 'inferred'},
        {'op': 'set', 'path': ['provDetail', 'valueProbs'], 'value': {'some_label': 0.9}},
    ]
    client = make_client({'d1': 8})
    result = client.spans.bulk_update([
        {'id': 's1', 'value': 'NOUN', 'metadata': ops},
        {'id': 's2', 'value': None},
    ])

    assert result == {'count': 2}
    [call] = client.session.calls
    assert call['method'] == 'PATCH'
    assert call['url'] == 'http://plaid.test/api/v1/spans/bulk'
    assert json.loads(call['data']) == [
        {'id': 's1', 'value': 'NOUN', 'metadata': ops},
        {'id': 's2', 'value': None},
    ]


def test_every_document_in_the_header_is_learned_not_just_the_first():
    client = make_client({'d1': 8, 'd2': 3})
    client.spans.bulk_update([{'id': 's1', 'value': 'X'}, {'id': 's2', 'value': 'Y'}])
    assert client.document_versions == {'d1': 8, 'd2': 3}


def test_relations_and_tokens_take_the_same_round_trip():
    client = make_client({'d1': 9, 'd2': 4})
    client.relations.bulk_update([{'id': 'r1', 'value': 'nsubj'}])
    client.tokens.bulk_update([{'id': 't1', 'metadata': [{'op': 'set', 'path': ['form'], 'value': 'cd'}]}])

    paths = [c['url'] for c in client.session.calls]
    assert paths == ['http://plaid.test/api/v1/relations/bulk',
                     'http://plaid.test/api/v1/tokens/bulk']
    assert all(c['method'] == 'PATCH' for c in client.session.calls)
    assert client.document_versions == {'d1': 9, 'd2': 4}
