"""Undo one audit entry: ``client.audit.undo``, and the fake's recorded form
of it. What each call sends is in the shared requests fixture
(test_requests.py). Here: what the answer becomes, as the JS client's
test/auditUndo.test.js has it."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client import PlaidClient
from plaid_client.testing import FakeClient, recording_session

COUNTS = {'inserted': 0, 'updated': 1, 'deleted': 2}

SUMMARY = {
    'entry': 'e1',
    'dry-run': False,
    'undone': {'documents': COUNTS, 'vocab-links': COUNTS, 'vocab-items': COUNTS},
    'total': 3,
    'rows': 5,
    'skipped': [
        {'kind': 'token', 'id': 't1', 'document': 'd1', 'reason': 'built-on',
         'by': {'kind': 'span', 'id': 's1'}},
        {'kind': 'vocab-item', 'id': 'i1', 'vocab-layer': 'v1', 'reason': 'needs',
         'needs': {'kind': 'vocab-layer', 'id': 'v1'}},
    ],
    'skipped-count': 2,
    'not-undone': [{'op-type': 'span-layer/update', 'count': 1}],
    'operation': 'o1',
}


def test_an_undos_summary_is_recased_its_skipped_rows_with_the_row_each_names():
    client = PlaidClient('http://x', 'tok')
    client.session = recording_session([SUMMARY])
    assert client.audit.undo('e1') == {
        'entry': 'e1',
        'dry_run': False,
        'undone': {'documents': COUNTS, 'vocab_links': COUNTS, 'vocab_items': COUNTS},
        'total': 3,
        'rows': 5,
        'skipped': [
            {'kind': 'token', 'id': 't1', 'document': 'd1', 'reason': 'built-on',
             'by': {'kind': 'span', 'id': 's1'}},
            {'kind': 'vocab-item', 'id': 'i1', 'vocab_layer': 'v1', 'reason': 'needs',
             'needs': {'kind': 'vocab-layer', 'id': 'v1'}},
        ],
        'skipped_count': 2,
        'not_undone': [{'op_type': 'span-layer/update', 'count': 1}],
        'operation': 'o1',
    }
    assert client.session.sent[0]['method'] == 'POST'


def test_the_fake_records_an_undo_and_answers_its_summary():
    summary = {'entry': 'e1', 'total': 2, 'skipped': [], 'skipped_count': 0}
    fake = FakeClient({}, undo_summary=summary)
    assert fake.audit.undo('e1', dry_run=True, document_id='d1') == summary
    assert fake.audit.undo('e1') == summary
    assert [c for c in fake.calls if c[0] == 'audit.undo'] == [
        ('audit.undo', {'args': ('e1',), 'kwargs': {'dry_run': True, 'document_id': 'd1',
                                                     'vocab_layer_id': None}}),
        ('audit.undo', {'args': ('e1',), 'kwargs': {'dry_run': False, 'document_id': None,
                                                     'vocab_layer_id': None}}),
    ]
