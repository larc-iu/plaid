"""Apply again after a run whose writes landed (REV-FX9-PLAN).

A service that stops after its batch commits and before the record says so
leaves the card offering Apply again. Its writes moved the document's version
and changed the sentences the plan is pinned to, so the staleness check
refused the run again with "Nothing was written. Sentence 5 ... has changed
since the plan was made", which was false, and the plan could never finish.
A document the first run held (``held_from``) is now sent again at the
versions that run held it at: what landed is answered from its first send,
and what did not claims the version the replays leave, which the server
refuses if anyone else wrote since.
"""

import copy

import pytest

import test_lost_answers as la
import test_stale_by_sentence as sbs

from plaid_agent.core import plan as core_plan
from plaid_agent.core.plan import HELD_FROM
from plaid_agent.core.service import stale_documents


def _store(client):
    return client.user_data.store


@pytest.mark.parametrize('app', sorted(sbs.APPS))
def test_a_run_again_over_its_own_landed_writes_is_not_refused_as_out_of_date(app, monkeypatch):
    spec = sbs.APPS[app]()
    client = spec['client']()
    plan, _ = sbs._plan(spec, client)
    assert plan['documents'][0].get('sentences'), 'pinned by sentence'
    record = {}
    real = core_plan.Batcher.flush

    def lost(self):
        # The batch commits, the service stops before the record says so.
        real(self)
        record.update(copy.deepcopy(_store(client)))
        raise la._lost()

    monkeypatch.setattr(core_plan.Batcher, 'flush', lost)
    sbs._approve(spec, client, plan)
    assert record
    monkeypatch.setattr(core_plan.Batcher, 'flush', real)
    # What the landed batch did on the server: the pinned sentence changed and
    # the version moved on.
    sbs._edit(client, spec, spec['same'])
    _store(client).clear()
    _store(client).update(record)
    helper = sbs._approve(spec, client, plan)
    assert not helper.errors, helper.errors
    [done] = helper.done
    assert done['kind'] == 'applied', done


def test_a_document_no_run_has_held_is_still_checked():
    class Docs:
        def get(self, did):
            return {'id': did, 'name': 'Text 1', 'version': 9}

    class Client:
        documents = Docs()

    pinned = {'id': 'd1', 'name': 'Text 1', 'version': 7}
    assert stale_documents(Client(), [pinned]) == ['document "Text 1" has changed since the plan was made']
    assert stale_documents(Client(), [{**pinned, HELD_FROM: 7}]) == []
