"""One thing at a time per conversation, decided against the record as stored
(H10-RECORD, the polish campaign of 2026-10-02).

H10-RECORD-2: an approval whose conversation moved on while it ran (another
tab's message claimed it) wrote its changes and left the plan undecided, the
model never heard it was applied, and a second approval answered "duplicate"
and changed nothing on the record.

H10-RECORD-3: a plan whose interrupted approval may have written could be
discarded with "nothing was changed". The run now marks the plan ``writing``
before it sends anything, so the page can tell.

H10-RECORD-6: an approval refused because the record was full said the plan
was too large to apply in one go.
"""

from plaid_client import PlaidAPIError

from fixtures import FakeClient
from test_service_flow import PLAN1, Helper, _request, _seed_plan, _service

from plaid_agent.core import plan as core_plan
from plaid_agent.core.conversation import ConversationStore, compact_plan, meta_key
from plaid_agent.core.plan import RECORD_FULL, WRITING, PlanError, RecordFull, writing


def _claim(client, request_id='r-turn'):
    """Another tab's message claims the conversation."""
    store = ConversationStore(client, 'u@x', 'p1', 'igt')
    meta = store.meta('c1')
    meta['pending'] = {'kind': 'turn', 'request_id': request_id, 'service_id': 'igt:assist:fake'}
    store._put(meta_key('igt', 'p1', 'c1'), meta)


def test_an_approval_whose_conversation_moved_on_still_settles_the_plan_applied():
    client = FakeClient()
    store = _seed_plan(client)
    svc = _service()
    real = svc.execute_plan

    def execute(*a, **k):
        out = real(*a, **k)
        _claim(client)
        return out

    svc.execute_plan = execute
    helper = Helper(request_id='r9')
    svc.process_request(_request(client, approve={'plan_id': PLAN1}), helper)
    assert not helper.errors, helper.errors
    assert helper.done[0]['kind'] == 'applied' and not helper.done[0].get('duplicate')
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] == 'applied'
    assert conv['messages'][-1]['content'].startswith('(note) The plan was approved and applied: 1 field value.')
    # The other tab's turn is still the one under way.
    assert meta['pending']['request_id'] == 'r-turn'


def test_a_second_approval_settles_a_plan_this_process_applied_and_says_so():
    client = FakeClient()
    store = _seed_plan(client, request_id='r10')
    svc = _service()
    svc._remember_applied(PLAN1, 'applied', '(note) The plan was approved and applied: 1 field value.',
                          {'as_human': False})
    helper = Helper(request_id='r10')
    svc.process_request(_request(client, approve={'plan_id': PLAN1}), helper)
    assert helper.done[0]['duplicate'] is True
    assert helper.done[0]['message'] == 'This plan was already applied. Nothing was written again.'
    assert not client.payloads('spans.create')
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] == 'applied'
    assert conv['messages'][-1]['content'] == '(note) The plan was approved and applied: 1 field value.'
    assert meta['pending'] is None


def test_a_run_marks_the_plan_writing_before_its_first_change_is_sent():
    client = FakeClient()
    store = _seed_plan(client)
    svc = _service()
    real = svc.execute_plan
    seen = []

    def execute(*a, **k):
        conv, _ = store.load('c1')
        seen.append(conv['display'][1]['plan'].get(WRITING))
        return real(*a, **k)

    svc.execute_plan = execute
    svc.process_request(_request(client, approve={'plan_id': PLAN1}), Helper(request_id='r9'))
    assert seen == ['r9'], 'marked, naming the run'
    conv, _ = store.load('c1')
    # Settled, so compacted: the mark goes with the rest of what approving needed.
    assert conv['display'][1]['status'] == 'applied'
    assert WRITING not in conv['display'][1]['plan']


def test_a_run_that_certainly_wrote_nothing_drops_the_mark():
    client = FakeClient()
    store = _seed_plan(client)
    svc = _service()

    def execute(*a, **k):
        raise PlanError('refused', applied=0, total=1)

    svc.execute_plan = execute
    helper = Helper(request_id='r9')
    svc.process_request(_request(client, approve={'plan_id': PLAN1}), helper)
    assert helper.errors and 'Nothing was written' in helper.errors[0]
    conv, meta = store.load('c1')
    item = conv['display'][1]
    assert item['status'] is None and WRITING not in item['plan']
    assert meta['pending'] is None


def test_every_run_marks_the_plan_in_one_write_naming_the_run():
    """A run again writes the record before it sends anything too: that write
    is where an approval meets a discard of the same plan (REV-FX12)."""
    plan = {'id': PLAN1}
    calls = []
    client = FakeClient()
    writing(client, plan, [], lambda: calls.append(dict(plan)) or True, run='r1')
    assert plan[WRITING] == 'r1' and len(calls) == 1
    writing(client, plan, [], lambda: calls.append(dict(plan)) or True, run='r2')
    assert len(calls) == 2 and calls[-1][WRITING] == 'r2'


def _discard_before_the_first_send(client, svc):
    """Another tab's discard lands after the approval read the record and
    before its run marks the plan: a write held up past the discard's claim
    (REV-FX12)."""
    real = svc._stale

    def stale(*a, **k):
        store = ConversationStore(client, 'u@x', 'p1', 'igt')
        conv, meta = store.load('c1')
        conv['display'][1]['status'] = 'discarded'
        conv['messages'].append({'role': 'user', 'content': '(note) The user discarded the plan; nothing was changed.'})
        store.save('c1', conv, meta)
        return real(*a, **k)

    svc._stale = stale


def test_an_approval_never_writes_a_plan_discarded_before_its_first_change():
    client = FakeClient()
    store = _seed_plan(client)
    svc = _service()
    _discard_before_the_first_send(client, svc)
    helper = Helper(request_id='r9')
    svc.process_request(_request(client, approve={'plan_id': PLAN1}), helper)
    assert helper.errors == ['The plan was discarded. Nothing was written.']
    assert not [k for k, _ in client.calls if k.startswith(('spans.', 'batch', 'tokens.'))]
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] == 'discarded'
    assert not any('applied' in (m.get('content') or '') for m in conv['messages'])
    assert meta['pending'] is None


def test_a_run_again_that_writes_nothing_keeps_the_mark_and_the_held_versions():
    """Its earlier run may have written: the plan stays one that cannot be
    discarded as if nothing had happened, and a later run repeats the earlier
    run's requests."""
    client = FakeClient()
    store = _seed_plan(client)
    conv, meta = store.load('c1')
    conv['display'][1]['interrupted'] = True
    conv['display'][1]['plan'][WRITING] = 'r-first'
    conv['display'][1]['plan']['documents'][0][core_plan.HELD_FROM] = 7
    store.save('c1', conv, meta)
    svc = _service()

    def execute(*a, **k):
        raise PlanError('refused', applied=0, total=1)

    svc.execute_plan = execute
    helper = Helper(request_id='r9')
    svc.process_request(_request(client, approve={'plan_id': PLAN1}), helper)
    assert helper.errors and 'Nothing was written' in helper.errors[0]
    conv, meta = store.load('c1')
    plan = conv['display'][1]['plan']
    assert conv['display'][1]['status'] is None
    assert plan.get(WRITING) == 'r-first'
    assert plan['documents'][0].get(core_plan.HELD_FROM) == 7


def test_a_record_too_full_for_the_approval_says_the_conversation_is_full():
    client = FakeClient()
    store = _seed_plan(client)
    real = client.user_data.put

    def put(user_id, key, value, version=None):
        if ':conv:' in key:
            raise PlaidAPIError('HTTP 413 Value exceeds 1048576 bytes', status=413, method='PUT')
        return real(user_id, key, value, version=version)

    client.user_data.put = put
    helper = Helper(request_id='r9')
    _service().process_request(_request(client, approve={'plan_id': PLAN1}), helper)
    assert helper.errors == [RECORD_FULL]
    assert RECORD_FULL == 'This conversation is full, so the plan was not applied. Start a new conversation to go on.'
    assert not client.payloads('spans.create')
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] is None and meta['pending'] is None


def test_an_expansion_the_record_cannot_take_is_the_record_being_full():
    def remember():
        raise PlaidAPIError('HTTP 413', status=413, method='PUT')

    expansion = core_plan.Expansion({'id': PLAN1}, remember)
    expansion.record({core_plan.ROW: 0}, [{'kind': 'set_span', 'span_id': 's1', 'value': 'x'}])
    try:
        expansion.save()
    except RecordFull as e:
        assert str(e) == RECORD_FULL
    else:
        raise AssertionError('not refused')
    assert core_plan.EXPANSION not in expansion.plan


def test_the_mark_is_compacted_away_once_settled():
    item = {'kind': 'assistant', 'status': 'discarded',
            'plan': {'id': PLAN1, 'ops': [{}], 'documents': [], WRITING: True}}
    assert WRITING not in compact_plan(item)['plan']
    undecided = {**item, 'status': None}
    assert compact_plan(undecided)['plan'][WRITING] is True
