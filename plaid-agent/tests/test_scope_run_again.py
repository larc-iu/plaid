"""A corpus-wide change stored as one change (a scope) and approved again
after its first run wrote part of it sends the requests the first run sent.

Every request of an approval is keyed by the plan's id and its place in the
operation (``<seed>.<n>``), and the core answers a keyed request it has seen
from its first send, or refuses it as ``idempotency-key-reused`` when the
same key comes with another body. A run again must therefore send, under each
key the first run used, the very request it sent then.

A scope is resolved at approval by reading the corpus. Read again after a
first run that landed some of its writes, it finds those values already
changed and stands for fewer changes, so its batches would differ from the
first run's (RULE-PLANS.md section 1, "A safe second run"). The first run
records what each scope resolved to (``plan.expansion``) before its first
send, and a run again uses that record instead of reading the corpus.
"""

import copy

from plaid_client import testing as fake_mod

import fixtures as igt_fx
from test_replaced_work_corpus import _gloss_row, _igt_ws, _store
from test_stale_by_sentence import APPS, _approve
from test_one_change_per_batch import _budget
import test_lost_answers as la

from plaid_agent.core import plan as core_plan


SPANS = {f'sp-{i}': ('w-1' if i % 2 else 'w-2', 'd1' if i < 4 else 'd2') for i in range(1, 7)}


def _corpus(client, store):
    """The query engine over ``store`` (span id -> value), as the core
    answers it now: only the spans whose value still holds "Ali"."""
    def query(body):
        where = body.get('where') or []
        if where and where[0][0] == 'document':
            return {'return': 'entities', 'results': [
                [{'id': d, 'version': client._documents[d]['version']}]
                for d in where[0][2]['id'] if d in client._documents]}
        if body.get('return') == 'entities':
            return {'return': 'entities', 'results': [
                list(_gloss_row(sid, store[sid], tok, doc=doc)) for sid, (tok, doc) in SPANS.items()
                if 'ali' in store[sid].lower()]}
        return {'return': 'aggregate', 'results': []}
    client.query = query


def _plan(monkeypatch):
    from plaid_agent.igt import bulk
    from plaid_agent.igt.toolkit import call_tool
    monkeypatch.setattr(bulk, 'PLAN_MAX_OPS', 1)
    store = {sid: 'Ali' for sid in SPANS}
    client, ws = _igt_ws(monkeypatch, [])
    second = copy.deepcopy(igt_fx.document_raw())
    second['id'], second['name'] = 'd2', 'Text 2'
    client._documents['d2'] = second
    _corpus(client, store)
    call_tool(ws, 'replace_in_field', {'field': 'Gloss', 'pattern': 'Ali', 'replacement': 'Bob'})
    assert [op['kind'] for op in ws.ops] == ['bulk_scope'], ws.ops
    return client, store, _store(ws, client, igt_fx.PID, 'igt')


def _sends(monkeypatch):
    """Every batch that reached the fake, as the list of what it held."""
    sent = []
    real = fake_mod._Batch.submit

    def submit(batch):
        sent.append(repr(batch.queued))
        return real(batch)
    monkeypatch.setattr(fake_mod._Batch, 'submit', submit)
    return sent


def test_a_scope_approved_again_after_a_partial_write_sends_what_its_first_run_sent(monkeypatch):
    client, store, plan = _plan(monkeypatch)
    _budget(monkeypatch, 2)
    sent = _sends(monkeypatch)
    record = {}
    real = core_plan.Batcher.flush
    calls = []

    def lost_after_first(self):
        # The first batch commits and its answer is lost: the service stops
        # there, with the record as it was written before the first send.
        real(self)
        if not calls:
            calls.append(1)
            record.update(copy.deepcopy(client.user_data.store))
            raise la._lost()

    monkeypatch.setattr(core_plan.Batcher, 'flush', lost_after_first)
    spec = APPS['igt']()
    _approve(spec, client, plan)
    first = list(sent)
    assert first, 'the first run sent a batch'
    landed = dict(client.updates('spans'))
    assert landed and len(landed) < len(SPANS), landed
    # What landed is in the corpus now, and each document's version moved.
    for sid, value in landed.items():
        store[sid] = value
    for d in {SPANS[sid][1] for sid in landed}:
        client._documents[d]['version'] += 1
    monkeypatch.setattr(core_plan.Batcher, 'flush', real)
    # The restart: the record as the first run left it, a new service.
    client.user_data.store.clear()
    client.user_data.store.update(record)
    del sent[:]
    helper = _approve(APPS['igt'](), client, plan)
    assert not helper.errors, helper.errors
    assert sent[:len(first)] == first, 'the run again sends, under each key, what the first run sent'
    assert {sid: v for sid, v in client.updates('spans')} == {sid: 'Bob' for sid in SPANS}
