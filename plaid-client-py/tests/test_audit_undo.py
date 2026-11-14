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


def test_an_undo_goes_out_keyed_a_key_each_and_waits_as_long_as_a_batch():
    # An undo holds the write lock for its whole run, as a batch does, and may
    # take longer than one request's timeout. A key of its own for the dry run
    # and for the real call, so a lost answer is sent again.
    client = PlaidClient('http://x', 'tok', timeout=30, batch_timeout=180)
    client.session = recording_session([{'entry': 'e1', 'total': 0, 'skipped': []}])
    client.audit.undo('e1', dry_run=True, document_id='d1')
    client.audit.undo('e1')
    keys = [(s['headers'] or {}).get('Idempotency-Key') for s in client.session.sent]
    assert keys[0] and keys[1] and keys[0] != keys[1]
    assert [s['timeout'] for s in client.session.sent] == [180, 180]


def test_an_undo_whose_answer_was_lost_is_sent_again_under_its_key():
    import requests
    client = PlaidClient('http://x', 'tok', retry_delays=[0, 0, 0])
    keys = []

    def answer(kw):
        keys.append((kw['headers'] or {}).get('Idempotency-Key'))
        if len(keys) == 1:
            raise requests.ConnectionError('lost')
        return {'entry': 'e1', 'total': 3, 'operation': 'o1'}

    client.session = recording_session(answer)
    assert client.audit.undo('e1', document_id='d1')['operation'] == 'o1'
    assert len(keys) == 2 and keys[0] == keys[1]


def test_an_undo_never_joins_an_open_logical_operation():
    # An entry of its own: no group stamp while the caller has an operation open.
    client = PlaidClient('http://x', 'tok')
    client.session = recording_session([{'entry': 'e1', 'total': 1, 'operation': 'o1'}])
    with client.operation('Edit'):
        client.audit.undo('e1', document_id='d1')
    sent = [s for s in client.session.sent if '/undo' in s['url']]
    assert len(sent) == 1
    assert 'group-id' not in repr(sent[0])
    assert (sent[0]['headers'] or {}).get('Idempotency-Key')


def test_the_fake_records_several_entries_and_a_job_undone():
    summary = {'entries': ['e1', 'e2'], 'total': 3, 'skipped': [], 'skipped_count': 0}
    fake = FakeClient({}, undo_summary=summary)
    assert fake.audit.undo_entries(['e1', 'e2'], dry_run=True) == summary
    assert ('audit.undo_entries', {'args': (['e1', 'e2'],), 'kwargs': {'dry_run': True}}) in fake.calls


def test_the_fake_undoes_a_job_only_once_it_has_ended():
    import pytest
    from plaid_client.http import PlaidAPIError
    summary = {'entries': ['g1'], 'total': 1, 'skipped': [], 'skipped_count': 0}
    fake = FakeClient({'d1': {'id': 'd1', 'name': 'One'}}, undo_summary=summary, project={'id': 'p1'})
    job = fake.jobs.create('p1', 'igt', 'Gloss')
    with pytest.raises(PlaidAPIError) as refused:
        fake.jobs.undo(job['id'])
    assert refused.value.status == 409
    fake.jobs.cancel(job['id'])
    assert fake.jobs.undo(job['id'], dry_run=True) == summary


def test_the_fake_job_reads_undone_after_an_undo_that_wrote():
    summary = {'entries': ['g1'], 'total': 1, 'skipped': [], 'skipped_count': 0, 'operation': 'o1'}
    fake = FakeClient({'d1': {'id': 'd1', 'name': 'One'}}, undo_summary=summary, project={'id': 'p1'})
    job = fake.jobs.create('p1', 'igt', 'Gloss')
    fake.jobs.cancel(job['id'])
    fake.jobs.undo(job['id'], dry_run=True)
    assert 'undone' not in fake.jobs.get(job['id'])
    fake.jobs.undo(job['id'])
    undone = fake.jobs.get(job['id'])['undone']
    assert undone['operation'] == 'o1' and undone['user'] == fake.jobs.user and undone['time']
