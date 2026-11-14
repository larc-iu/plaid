"""A plan sent as ONE request (``core.plan.ONE_REQUEST``), as a job sends
each try of its writes: the batcher sends nothing before the plan's end
(``last``), calls the caller back once just before the request goes out,
and refuses a plan that does not fit one request, or that would need a
second, before anything is sent (BRIEF RX, RX-FIX)."""

import pytest

from plaid_client import MAX_BATCH_OPS
from plaid_client.testing import FakeClient

from plaid_agent.core import plan as core_plan


def _batcher(called):
    client = FakeClient([])
    setattr(client, core_plan.ONE_REQUEST, lambda: called.append(len(client.batches)))
    return client, core_plan.TrackingBatcher(client, budget=2)


def test_one_request_is_sent_at_the_plans_end_and_called_back_just_before():
    called = []
    client, b = _batcher(called)
    for i in range(5):
        with b.writing_for({}):
            b.add(lambda batch, i=i: batch.tokens.create('l1', 't1', i, i + 1))
        b.update('spans', f's{i}', value='x')
    assert not client.batches and not called, 'past the budget, nothing sent before the end'
    b.flush()
    assert not client.batches and not called, 'a batch the executor closes is held'
    b.last()
    assert called == [0], 'called back once, before the request'
    assert len(client.batches) == 1 and len(client.batches[0]) == 6


def test_a_plan_that_does_not_fit_one_request_is_refused_before_anything_is_sent():
    called = []
    client, b = _batcher(called)
    with pytest.raises(core_plan.TooBig):
        for i in range(MAX_BATCH_OPS + 1):
            b.add(lambda batch, i=i: batch.tokens.create('l1', 't1', i, i + 1))
    assert not client.batches and not called


def test_a_second_request_is_refused_before_anything_is_sent():
    """REV-RX-1: a batch the executor closed and a write on the client, or a
    write after the batch was closed (``_merge``'s batch before a merge, the
    lexicon's after the document's), is a second request: refused before
    the first goes out, so the caller cuts the plan again."""
    called = []
    client, b = _batcher(called)
    b.add(lambda batch: batch.tokens.create('l1', 't1', 0, 1))
    b.flush()
    with pytest.raises(core_plan.NeedsTwo):
        with b.on_client('d1'):
            client.tokens.create('l1', 't1', 1, 2)
    with pytest.raises(core_plan.NeedsTwo):
        b.add(lambda batch: batch.tokens.create('l1', 't1', 2, 3))
    b.update('spans', 's1', value='x')
    with pytest.raises(core_plan.NeedsTwo):
        b.last()
    assert called == [] and client.batches == []
    assert issubclass(core_plan.NeedsTwo, core_plan.TooBig), 'cut as a try too big is'


def test_a_write_on_the_client_is_called_back_once_before_it_goes_out():
    called = []
    client, b = _batcher(called)
    b.flush()
    assert not called, 'an empty plan sends nothing'
    with b.on_client('d1'):
        client.tokens.create('l1', 't1', 1, 2)
    assert called == [0]
