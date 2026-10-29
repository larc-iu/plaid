"""An approval whose run dies (the service stopped or was killed while it
applied) settles its plan as partly applied, may be written, as a run that
stopped partway does (Luke's ruling R53, 2026-10-29). Nothing is applied
again: the person asks the assistant to plan the rest.

R2-3 (beta-final 2026-10-29): a run that died before its first change, on a
document a person then edited, left a card that could be neither applied (409,
"Nothing was written", the old mark put back) nor discarded ("written")."""

from fixtures import FakeClient
from test_service_flow import PLAN1, Helper, _seed_plan, _service
from test_single_writer import _answering, _req, _send, _set_meta

from plaid_agent.core.conversation import ConversationStore, compact_plan


class _Died(BaseException):
    """The service process going away in the middle of a run."""


def _die_while_applying(client, *, after_write=False):
    """Approve the plan on a service that dies before it sends its first
    change, or after it (``after_write``). Its marker stays on the record,
    naming a request no process runs any more."""
    svc = _service()

    def execute(*a, **k):
        if after_write:
            client.spans.create('sl-gloss', 'w-2', 'fish')
        raise _Died()
    svc.execute_plan = execute
    try:
        svc.process_request(_req(client, 'approve', plan_id=PLAN1), Helper(request_id='r-dead'))
    except _Died:
        pass


def _settled_item(client):
    conv, meta = ConversationStore(client, 'u@x', 'p1', 'igt').load('c1')
    return conv, meta, conv['display'][1]


def test_r2_3_a_run_that_died_before_writing_on_a_document_edited_since_is_not_stuck(monkeypatch):
    client = FakeClient()
    _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    _die_while_applying(client)
    conv, meta, _ = _settled_item(client)
    assert (meta.get('pending') or {}).get('request_id') == 'r-dead', 'the dead run left its marker'
    # A person edits the document the plan writes.
    client._documents['d1']['version'] = 9
    # The service comes back: the next op on the conversation settles what
    # the dead run left.
    svc = _service()
    hold = Helper(request_id='h1')
    svc.process_request(_req(client, 'hold'), hold)
    conv, meta, item = _settled_item(client)
    assert meta['pending'] is None
    assert item['status'] == 'partial'
    assert item['written'] == []
    assert item['outcome'] == 'Applying stopped before it finished. Some changes may be written.'
    assert conv['messages'][-1]['content'].startswith('(note) Applying stopped before it finished')
    # Approving it again is refused, as any partly applied plan, and writes nothing.
    approve = Helper(request_id='a2')
    svc.process_request(_req(client, 'approve', plan_id=PLAN1), approve)
    assert approve.errors == ['This plan was partly applied. Ask the assistant to finish it.']
    assert not client.payloads('spans.create')
    # The conversation goes on: a message is answered.
    _answering(monkeypatch)
    sent = _send(svc, client, text='finish it', rid='s1', create=False)
    assert sent.done[0]['kind'] == 'turn'


def test_a_run_that_died_after_writing_settles_the_same_way():
    client = FakeClient()
    _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    _die_while_applying(client, after_write=True)
    svc = _service()
    svc.process_request(_req(client, 'hold'), Helper(request_id='h1'))
    _, meta, item = _settled_item(client)
    assert meta['pending'] is None and item['status'] == 'partial' and item['written'] == []
    assert 'ops' not in item['plan'], 'settled plans are compacted'
    approve = Helper(request_id='a2')
    svc.process_request(_req(client, 'approve', plan_id=PLAN1), approve)
    assert approve.errors == ['This plan was partly applied. Ask the assistant to finish it.']
    assert len(client.payloads('spans.create')) == 1, 'nothing written a second time'


def test_a_dead_approval_keeps_how_it_was_asked_to_be_recorded():
    client = FakeClient()
    _seed_plan(client, request_id='r-dead')
    _set_meta(client, pending={'kind': 'apply', 'request_id': 'r-dead', 'service_id': 'igt:assist:fake',
                               'plan_id': PLAN1, 'as_human': True})
    _service().process_request(_req(client, 'hold'), Helper(request_id='h1'))
    _, _, item = _settled_item(client)
    assert item['status'] == 'partial' and item['as_human'] is True


def test_a_run_another_process_took_for_dead_settles_applied_once_it_writes_everything():
    """A second process under the same service id cannot see the first one's
    run and settles its plan partly applied. The run then writes the whole
    plan and answers Applied: the card says applied too (REV-FX-R53-2)."""
    client = FakeClient()
    _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    svc1, svc2 = _service(), _service()
    real = svc1.execute_plan
    seen = {}

    def execute(*a, **k):
        out = real(*a, **k)
        svc2.process_request(_req(client, 'hold'), Helper(request_id='h-other'))
        seen['mid'] = _settled_item(client)[2].get('status')
        return out
    svc1.execute_plan = execute
    helper = Helper(request_id='a1')
    svc1.process_request(_req(client, 'approve', plan_id=PLAN1), helper)
    assert seen['mid'] == 'partial', 'the other process settled the run it took for dead'
    assert helper.done[0]['kind'] == 'applied' and not helper.done[0].get('partial')
    conv, meta, item = _settled_item(client)
    assert item['status'] == 'applied'
    assert 'outcome' not in item and 'written' not in item
    assert conv['messages'][-1]['content'].startswith('(note) The plan was approved and applied')


def test_a_record_holding_the_old_apply_again_keys_reads_and_applies():
    """A plan stored by the code before R53 may carry ``writing``,
    ``expansion``, ``held_from`` and ``interrupted``. Nothing reads them now:
    the plan is approved as any other, and they do no harm on a settled card."""
    client = FakeClient()
    store = _seed_plan(client, request_id=None)
    conv, meta = store.load('c1')
    item = conv['display'][1]
    item['interrupted'] = True
    item['plan']['writing'] = {'run': 'r-old', 'inside': True, 'stamp': 'human'}
    item['plan']['expansion'] = {'0': {'n': 1, 'z': 'garbage', 'fp': 'x'}}
    item['plan']['documents'][0]['held_from'] = 5
    store.save('c1', conv, {**meta, 'pending': None})
    helper = Helper(request_id='a1')
    _service().process_request(_req(client, 'approve', plan_id=PLAN1), helper)
    assert not helper.errors, helper.errors
    assert helper.done[0]['kind'] == 'applied'
    _, _, item = _settled_item(client)
    assert item['status'] == 'applied' and item['as_human'] is False
    assert compact_plan(item) == item
