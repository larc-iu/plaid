"""A plan of chained rules approved again after its service stopped at any
point of its first run sends, under each key, what the first run sent, and
the corpus ends as one uninterrupted run leaves it (REV-FX11, on the packed
expansion of fe3a74fbb).

The first run records what each rule writes, after a later rule takes its
values (``plan.expansion``), before its first send. The service stops after a
batch committed with its answer lost (a batch boundary), or with a batch sent
and never committed (mid-batch), at every batch of the run. The restart reads
the record as the stopped run left it and approves again.
"""

import copy

import pytest

from plaid_client import testing as fake_mod

import fixtures as igt_fx
from test_replaced_work_corpus import _gloss_row, _igt_ws, _store
from test_stale_by_sentence import APPS, _approve
from test_one_change_per_batch import _budget
import test_lost_answers as la

from plaid_agent.core import plan as core_plan

# One Gloss value a word: span id -> (token, document, value).
SPANS = {'sp-1': ('w-1', 'd1', 'VASP'), 'sp-2': ('w-2', 'd1', 'VASP.3SG'), 'sp-3': ('w-3', 'd1', 'ASP'),
         'sp-4': ('w-4', 'd2', 'X'), 'sp-5': ('w-5', 'd2', 'VASP'), 'sp-6': ('w-6', 'd2', 'ASP.3SG')}
# VASP -> ASP, then ASP.3SG -> ASP.3PL: the second rule takes the value the
# first leaves on sp-2, and writes sp-6 itself.
WANT = {'sp-1': 'ASP', 'sp-2': 'ASP.3PL', 'sp-3': 'ASP', 'sp-4': 'X', 'sp-5': 'ASP', 'sp-6': 'ASP.3PL'}


def _corpus(client, store):
    def query(body):
        where = body.get('where') or []
        if where and where[0][0] == 'document':
            return {'return': 'entities', 'results': [
                [{'id': d, 'version': client._documents[d]['version']}]
                for d in where[0][2]['id'] if d in client._documents]}
        if body.get('return') == 'entities':
            return {'return': 'entities', 'results': [
                list(_gloss_row(sid, store[sid], tok, doc=doc)) for sid, (tok, doc, _v) in SPANS.items()
                if 'ASP' in store[sid]]}
        return {'return': 'aggregate', 'results': []}
    client.query = query


def _plan(monkeypatch):
    from plaid_agent.igt import bulk
    from plaid_agent.igt.toolkit import call_tool
    monkeypatch.setattr(bulk, 'PLAN_MAX_OPS', 1)
    store = {sid: v for sid, (_t, _d, v) in SPANS.items()}
    client, ws = _igt_ws(monkeypatch, [])
    second = copy.deepcopy(igt_fx.document_raw())
    second['id'], second['name'] = 'd2', 'Text 2'
    client._documents['d2'] = second
    _corpus(client, store)
    call_tool(ws, 'replace_in_field', {'field': 'Gloss', 'pattern': 'VASP', 'replacement': 'ASP'})
    call_tool(ws, 'replace_in_field', {'field': 'Gloss', 'pattern': 'ASP.3SG', 'replacement': 'ASP.3PL'})
    assert [op['kind'] for op in ws.ops] == ['bulk_scope', 'bulk_scope'], ws.ops
    return client, store, _store(ws, client, igt_fx.PID, 'igt')


def _sends(monkeypatch):
    sent = []
    real = fake_mod._Batch.submit

    def submit(batch):
        sent.append(repr(batch.queued))
        return real(batch)
    monkeypatch.setattr(fake_mod._Batch, 'submit', submit)
    return sent


def _whole_run(monkeypatch):
    client, store, plan = _plan(monkeypatch)
    _budget(monkeypatch, 1)
    sent = _sends(monkeypatch)
    helper = _approve(APPS['igt'](), client, plan)
    assert not helper.errors, helper.errors
    return list(sent), dict(client.updates('spans'))


@pytest.fixture(scope='module')
def batches():
    mp = pytest.MonkeyPatch()
    try:
        sent, written = _whole_run(mp)
    finally:
        mp.undo()
    assert {sid: written.get(sid, v) for sid, (_t, _d, v) in SPANS.items()} == WANT
    assert len(sent) == 4, sent
    return sent


@pytest.mark.parametrize('lands', [True, False], ids=['answer-lost', 'never-committed'])
@pytest.mark.parametrize('at', range(1, 5))
def test_a_run_again_after_a_stop_at_any_batch_sends_the_first_runs_requests(monkeypatch, batches, at, lands):
    client, store, plan = _plan(monkeypatch)
    _budget(monkeypatch, 1)
    sent = _sends(monkeypatch)
    record = {}
    real = core_plan.Batcher.flush
    flushed = []

    def stop(self):
        if self._batch is None and not any(self._bulk.values()):
            return real(self)
        flushed.append(1)
        if len(flushed) == at:
            if lands:
                real(self)
            record.update(copy.deepcopy(client.user_data.store))
            raise la._lost()
        return real(self)

    monkeypatch.setattr(core_plan.Batcher, 'flush', stop)
    _approve(APPS['igt'](), client, plan)
    first = list(sent)
    assert first == batches[:at if lands else at - 1]
    landed = dict(client.updates('spans'))
    for sid, value in landed.items():
        store[sid] = value
    for d in {SPANS[sid][1] for sid in landed}:
        client._documents[d]['version'] += 1
    monkeypatch.setattr(core_plan.Batcher, 'flush', real)
    # The restart: the record as the stopped run left it, a new service.
    client.user_data.store.clear()
    client.user_data.store.update(record)
    del sent[:]
    helper = _approve(APPS['igt'](), client, plan)
    assert not helper.errors, helper.errors
    assert sent == batches, 'the run again sends, under each key, what an uninterrupted run sends'
    assert {sid: store.get(sid) for sid in SPANS} | dict(client.updates('spans')) == WANT


def _expansions(o):
    """Every stored expansion in the record, wherever the plan sits in it."""
    if isinstance(o, dict):
        if isinstance(o.get(core_plan.EXPANSION), dict):
            yield o[core_plan.EXPANSION]
        for v in o.values():
            yield from _expansions(v)
    elif isinstance(o, list):
        for v in o:
            yield from _expansions(v)


def _status(client):
    found = []

    def walk(o):
        if isinstance(o, dict):
            if isinstance(o.get('plan'), dict) and 'status' in o:
                found.append(o['status'])
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(list(client.user_data.store.values()))
    return found


@pytest.mark.parametrize('damage', ['digest', 'truncated', 'other shape'])
def test_a_record_that_does_not_read_back_sends_nothing_and_says_so(monkeypatch, damage):
    """A run again whose record of the first run does not read back sends
    nothing, says why, and settles the plan as partly applied: the first run
    may have written, so it is never told as nothing written, and the plan is
    not approved again over writes nobody can name (REV-FX11)."""
    client, store, plan = _plan(monkeypatch)
    _budget(monkeypatch, 1)
    sent = _sends(monkeypatch)
    record = {}
    real = core_plan.Batcher.flush
    flushed = []

    def stop(self):
        if self._batch is None and not any(self._bulk.values()):
            return real(self)
        flushed.append(1)
        if len(flushed) == 2:
            real(self)
            record.update(copy.deepcopy(client.user_data.store))
            raise la._lost()
        return real(self)

    monkeypatch.setattr(core_plan.Batcher, 'flush', stop)
    _approve(APPS['igt'](), client, plan)
    monkeypatch.setattr(core_plan.Batcher, 'flush', real)
    [expansion] = list(_expansions(record))
    for row, packed in list(expansion.items()):
        if damage == 'digest':
            packed['fp'] = '0' * 16
        elif damage == 'truncated':
            packed['z'] = packed['z'][:-7]
        else:
            expansion[row] = [{'kind': 'set_span'}]
    client.user_data.store.clear()
    client.user_data.store.update(record)
    del sent[:]
    helper = _approve(APPS['igt'](), client, plan)
    assert sent == []
    [said] = helper.errors
    assert said.startswith('Not applied again: what the earlier run of this plan found cannot be read back. '
                           'An earlier run may have written some of its changes, which History shows.'), said
    assert 'nothing was written' not in said.lower() and 'base64' not in said
    assert 'partial' in _status(client)
    # Approved once more, it is refused as partly applied, and sends nothing.
    again = _approve(APPS['igt'](), client, plan)
    assert sent == [] and again.errors == ['This plan was partly applied. Ask the assistant to finish it.']
