"""What one audit entry changed, row by row: ``client.audit.changes`` and
``changes_page``, and the fake's recorded form of them. What each read sends
is in the shared requests fixture (test_requests.py). Here: what the answer
becomes, as the JS client's test/auditChanges.test.js has it."""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient
from plaid_client.http import PlaidAPIError
from plaid_client.testing import FakeClient, recording_session

ROW = {
    'kind': 'vocab-link',
    'id': 'l1',
    'document': 'd1',
    'before': {
        'vocab-link/id': 'l1',
        'vocab-link/vocab-item': {'vocab-item/id': 'i1', 'vocab-item/layer': 'v1',
                                  'vocab-item/form': 'kai'},
        'vocab-link/tokens': ['t1'],
        'metadata': {'prov-source': 'human', 'provConfirmed': True},
    },
    'changed-since': False,
    'changed-between': True,
}


def test_an_entrys_rows_are_recased_as_a_document_reads_entities():
    client = PlaidClient('http://x', 'tok')
    client.session = recording_session([{'entries': [ROW], 'next-cursor': None}])
    assert client.audit.changes('e1') == [{
        'kind': 'vocab-link',
        'id': 'l1',
        'document': 'd1',
        'before': {'id': 'l1',
                   'vocab_item': {'id': 'i1', 'layer': 'v1', 'form': 'kai'},
                   'tokens': ['t1'],
                   'metadata': {'prov-source': 'human', 'provConfirmed': True}},
        'changed_since': False,
        'changed_between': True,
    }]


def test_changes_follows_every_page_and_changes_page_reads_one():
    client = PlaidClient('http://x', 'tok')
    client.session = recording_session([{'entries': [ROW], 'next-cursor': 'c1'},
                                        {'entries': [{**ROW, 'id': 'l2'}], 'next-cursor': None},
                                        {'entries': [ROW], 'next-cursor': 'c1'}])
    assert [r['id'] for r in client.audit.changes('e1')] == ['l1', 'l2']
    assert 'cursor=c1' in client.session.sent[1]['url']
    page = client.audit.changes_page('e1', limit=1)
    assert page['next_cursor'] == 'c1' and len(page['entries']) == 1


def _rows():
    return [{'kind': 'token', 'id': f't{i}', 'document': 'd1' if i < 3 else 'd2',
             'after': {'id': f't{i}'}, 'changed_since': False, 'changed_between': False}
            for i in range(5)] + [{'kind': 'vocab-item', 'id': 'i1', 'vocab_layer': 'v1',
                                   'before': {'id': 'i1', 'form': 'kai'},
                                   'changed_since': True, 'changed_between': False}]


def test_the_fake_answers_the_rows_it_was_given():
    fake = FakeClient([], unit_changes={'e1': _rows()})
    assert [r['id'] for r in fake.audit.changes('e1')] == ['t0', 't1', 't2', 't3', 't4', 'i1']
    assert [r['id'] for r in fake.audit.changes('e1', document_id='d2')] == ['t3', 't4']
    assert [r['id'] for r in fake.audit.changes('e1', vocab_layer_id='v1')] == ['i1']
    page = fake.audit.changes_page('e1', limit=4)
    rest = fake.audit.changes_page('e1', limit=4, cursor=page['next_cursor'])
    assert [r['id'] for r in page['entries'] + rest['entries']] == [r['id'] for r in _rows()]
    assert rest['next_cursor'] is None
    with pytest.raises(PlaidAPIError) as refused:
        fake.audit.changes('e2')
    assert refused.value.status == 404


def test_the_fakes_audit_stays_the_projects_log():
    fake = FakeClient([], audit=[{'id': 'a1', 'time': '2026-01-01T00:00:00Z', 'ops': []}],
                      unit_changes={'e1': _rows()})
    assert [e['id'] for e in fake.audit] == ['a1']
    fake.audit = [{'id': 'a2', 'time': '2026-01-02T00:00:00Z', 'ops': []}]
    assert fake.audit[0]['id'] == 'a2'
    assert len(fake.audit.changes('e1')) == 6
