"""Two chained rules ("Ali" -> "Bob", then "Bob" -> "Carl") approved again
after the first run wrote part of them (OPEN.md, FX-D-AGENT: "a replayed
rule's found values are not seen by a later rule"). A run again replays
what every rule of the plan resolved to on the first run, recorded before
its first send, so no later rule is resolved afresh over an earlier one's
replay, and the run again sends what the first run sent and finishes."""

import copy

from plaid_client import testing as fake_mod

import fixtures as igt_fx
from test_replaced_work_corpus import _gloss_row, _igt_ws, _store
from test_scope_run_again import SPANS, _sends
from test_stale_by_sentence import APPS, _approve
from test_one_change_per_batch import _budget
import test_lost_answers as la

from plaid_agent.core import plan as core_plan


def _corpus(client, store):
    """Every Gloss span as it stands: each rule's resolver matches its own
    pattern."""
    def query(body):
        where = body.get('where') or []
        if where and where[0][0] == 'document':
            return {'return': 'entities', 'results': [
                [{'id': d, 'version': client._documents[d]['version']}]
                for d in where[0][2]['id'] if d in client._documents]}
        if body.get('return') == 'entities':
            return {'return': 'entities', 'results': [
                list(_gloss_row(sid, store[sid], tok, doc=doc)) for sid, (tok, doc) in SPANS.items()]}
        return {'return': 'aggregate', 'results': []}
    client.query = query


def test_a_chain_of_rules_approved_again_after_a_partial_write_finishes_as_planned(monkeypatch):
    from plaid_agent.igt import bulk
    from plaid_agent.igt.toolkit import call_tool
    monkeypatch.setattr(bulk, 'PLAN_MAX_OPS', 1)
    store = {sid: 'Ali' if i % 3 else 'Bob' for i, sid in enumerate(SPANS)}
    client, ws = _igt_ws(monkeypatch, [])
    second = copy.deepcopy(igt_fx.document_raw())
    second['id'], second['name'] = 'd2', 'Text 2'
    client._documents['d2'] = second
    _corpus(client, store)
    call_tool(ws, 'replace_in_field', {'field': 'Gloss', 'pattern': 'Ali', 'replacement': 'Bob', 'whole': True})
    call_tool(ws, 'replace_in_field', {'field': 'Gloss', 'pattern': 'Bob', 'replacement': 'Carl', 'whole': True})
    assert [op['kind'] for op in ws.ops] == ['bulk_scope', 'bulk_scope'], ws.ops
    plan = _store(ws, client, igt_fx.PID, 'igt')
    _budget(monkeypatch, 2)
    sent = _sends(monkeypatch)
    record = {}
    real = core_plan.Batcher.flush
    calls = []

    def lost_after_first(self):
        real(self)
        if not calls:
            calls.append(1)
            record.update(copy.deepcopy(client.user_data.store))
            raise la._lost()

    monkeypatch.setattr(core_plan.Batcher, 'flush', lost_after_first)
    _approve(APPS['igt'](), client, plan)
    first = list(sent)
    landed = dict(client.updates('spans'))
    assert landed and len(landed) < len(SPANS), landed
    for sid, value in landed.items():
        store[sid] = value
    for d in {SPANS[sid][1] for sid in landed}:
        client._documents[d]['version'] += 1
    monkeypatch.setattr(core_plan.Batcher, 'flush', real)
    client.user_data.store.clear()
    client.user_data.store.update(record)
    del sent[:]
    helper = _approve(APPS['igt'](), client, plan)
    assert not helper.errors, helper.errors
    assert sent[:len(first)] == first
    # Every value ends as the chain leaves it.
    assert {sid: v for sid, v in client.updates('spans')} == {sid: 'Carl' for sid in SPANS}
