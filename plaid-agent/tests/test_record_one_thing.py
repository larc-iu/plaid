"""One thing at a time per conversation, decided against the record as stored
(H10-RECORD, the polish campaign of 2026-10-02).

H10-RECORD-2: an approval whose conversation moved on while it ran (another
tab's message claimed it) wrote its changes and left the plan undecided, the
model never heard it was applied, and a second approval answered "duplicate"
and changed nothing on the record.

A plan whose approval's run died is settled partly applied by the next op
(Luke's ruling R53, 2026-10-29, test_dead_approval.py), so it is never
discarded as if nothing had happened.
"""

from fixtures import FakeClient
from test_service_flow import PLAN1, Helper, _request, _seed_plan, _service

from plaid_agent.core.conversation import ConversationStore, meta_key
from plaid_agent.core.plan import PlanError


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


def test_a_second_approval_of_an_applied_plan_writes_nothing_again():
    client = FakeClient()
    store = _seed_plan(client, status='applied', request_id='r10')
    helper = Helper(request_id='r10')
    _service().process_request(_request(client, approve={'plan_id': PLAN1}), helper)
    assert helper.done[0]['duplicate'] is True
    assert helper.done[0]['message'] == 'This plan was already applied. Nothing was written again.'
    assert not client.payloads('spans.create')
    conv, meta = store.load('c1')
    assert conv['display'][1]['status'] == 'applied'
    assert meta['pending'] is None


def test_a_run_that_certainly_wrote_nothing_leaves_the_plan_undecided():
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
    assert item['status'] is None and item['plan']['ops']
    assert meta['pending'] is None


def _discard_before_the_first_send(client, svc):
    """Another tab's discard lands after the approval read the record and
    before its run sends its first change: a write held up past the discard's
    claim (REV-FX12)."""
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
