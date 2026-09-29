"""An assistant's Delete entry over an entry linked in a project the plan
cannot see (conc-2026-09-29 REV-W-PY2 D3).

The executor claims the links it reads in its own project, and the server
counts every project's, so the delete is refused with a 409 and the entry is
kept. The card said "Failed to apply the plan: HTTP 409 This entry has 3
links now, not 2. Nothing was written." and kept an Approve that failed the
same way every time. It now says why, and settles.
"""

import pytest
from plaid_client import PlaidAPIError

import test_lost_answers as la
from fixtures import FakeClient
from plaid_agent.core import plan as core_plan
from plaid_agent.igt.plan import execute_plan
from plaid_agent.igt.project import load_project


def _server_counts_more(monkeypatch):
    real = core_plan.Batcher.flush

    def flush(self):
        batch = self._batch
        if batch is not None and any(kind == 'vocab_items.delete' for kind, _ in batch.queued):
            raise PlaidAPIError('HTTP 409 This entry has 3 links now, not 1', status=409, method='POST',
                                response_data={'error': 'This entry has 3 links now, not 1', 'links': 3})
        real(self)
    monkeypatch.setattr(core_plan.Batcher, 'flush', flush)


def test_a_delete_alone_is_out_of_date_and_names_the_entry(monkeypatch):
    _server_counts_more(monkeypatch)
    c = FakeClient()
    ops = [{'kind': 'delete_entry', 'item_id': 'vi-erg', 'links': ['l-2'], 'name': '-di (ERG)',
            'label': 'Delete entry -di (ERG) (1 link removed)'}]
    with pytest.raises(core_plan.PlanOutOfDate) as caught:
        execute_plan(c, ops, source='s', label='l', project=load_project(c, 'p1'))
    assert caught.value.reasons == ['The entry -di (ERG) is linked in projects this assistant cannot open, '
                                    'so it was not deleted']


def test_a_delete_after_changes_that_stood_is_partly_applied(monkeypatch):
    _server_counts_more(monkeypatch)
    c = FakeClient()
    ops = [{'kind': 'rename_document', 'document_id': 'd1', 'name': 'Text One', 'label': 'Rename', '_row': 0},
           {'kind': 'delete_entry', 'item_id': 'vi-erg', 'links': ['l-2'], 'name': '-di (ERG)',
            'label': 'Delete entry', '_row': 1}]
    with pytest.raises(core_plan.PlanError) as caught:
        execute_plan(c, ops, source='s', label='l', project=load_project(c, 'p1'))
    assert str(caught.value) == ('The entry -di (ERG) is linked in projects this assistant cannot open, '
                                 'so it was not deleted')
    assert caught.value.written == [0]


def test_the_card_settles_with_no_approve(monkeypatch):
    spec = la.APPS['igt']()
    client = spec['client']()
    plan = la._plan_of(spec, client, ('delete_entry', {'entry_id': 'vi-erg'}), scan=True)
    _server_counts_more(monkeypatch)
    helper = la.sbs._approve(spec, client, plan)
    [error] = helper.errors
    assert error.startswith('Nothing was written. The entry ') and 'linked in projects this assistant cannot open' in error
    assert 'HTTP 409' not in error
    item = la._stored(spec, client)
    assert item['status'] == 'stale'
