"""Two approve buttons, always (the owner's ruling, 2026-11-12): "Approve as
unverified" writes every value the assistant sets as its unverified machine
proposal, as a service's proposal is written, and "Approve as verified" as
assistant work the approver verified, as Approve always did. A confirmation
is made under either button. Nothing is inferred from a change's text, tool
or size. "Record as human-made" wins over both. The page sends ``as_unverified`` beside
``as_human``, and the record keeps which was chosen, on every path a plan
settles by."""

import pytest

from fixtures import FakeClient
from test_dead_approval import _die_while_applying, _settled_item, _stop_partway
from test_service_flow import PLAN1, Helper, _seed_plan, _service
from test_single_writer import OTHER_TAB, _req, _set_meta

from plaid_agent.core.approval import approval_mode, recorded_as
from plaid_agent.core.opkind import ROW
from plaid_agent.core.plan import Stamps
from plaid_agent.core.prompt import PLAN_CONTRACT

SOURCE = 'service:igt:assist:fake'
DETAIL = {'model': 'm', 'version': 'v'}
BUTTONS = {'unverified': True, 'verified': False}


def _created(client):
    """The metadata the one span the seeded plan writes was created with."""
    made = [p['args'] for p in client.payloads('spans.create') if len(p.get('args') or []) > 3]
    assert len(made) == 1, made
    return made[0][3]


def test_the_unverified_mode_writes_the_assistants_proposal_and_confirms_as_the_approver():
    s = Stamps('unverified', SOURCE, detail=DETAIL)
    assert s.stamp() == {'prov': 'inferred', 'provSource': SOURCE, 'provDetail': DETAIL}
    assert s.restamp()['provConfirmed'] is None, 'a rewrite drops an earlier confirmation'
    assert s.confirm(False) == {'provConfirmed': True} and s.confirm(True) == {'provConfirmed': True}
    # A reviewed approver's confirmation is a contributor's, under either button.
    c = Stamps('unverified', SOURCE, contributor='bob@x.com', detail=DETAIL)
    assert c.reviewed and c.confirm(True) is None and c.confirm(False)['prov'] == 'contributed'
    assert c.stamp()['provSource'] == SOURCE and 'provConfirmed' not in c.stamp()
    # The verified mode is as it was, and a job's mode still needs its job.
    assert Stamps('verified', SOURCE, detail=DETAIL).stamp()['provConfirmed'] is True
    with pytest.raises(ValueError, match='job'):
        Stamps('machine', SOURCE, detail=DETAIL)


def test_which_mode_an_approval_writes_by_is_the_buttons_and_the_box():
    assert approval_mode(as_human=False, as_unverified=False, contributor=None) == 'verified'
    assert approval_mode(as_human=False, as_unverified=True, contributor=None) == 'unverified'
    # The box wins over both buttons.
    assert approval_mode(as_human=True, as_unverified=True, contributor=None) == 'human'
    assert approval_mode(as_human=True, as_unverified=False, contributor=None) == 'human'
    # A reviewed approver's verified approval is their contribution, as
    # before, and their unverified one is the assistant's proposal.
    assert approval_mode(as_human=False, as_unverified=False, contributor='u@x') == 'contributed'
    assert approval_mode(as_human=False, as_unverified=True, contributor='u@x') == 'unverified'
    assert approval_mode(as_human=True, as_unverified=True, contributor='u@x') == 'contributed'
    assert recorded_as('unverified') == {'as_human': False, 'as_unverified': True}
    assert recorded_as('verified') == {'as_human': False}
    assert recorded_as('human') == {'as_human': True}
    assert recorded_as('contributed') == {'as_human': False, 'contributed': True}


@pytest.mark.parametrize('button', sorted(BUTTONS))
def test_each_button_writes_every_change_as_it_says_and_the_record_says_which(button):
    client = FakeClient()
    store = _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    helper = Helper(request_id='r9')
    _service().process_request(_req(client, 'approve', plan_id=PLAN1, as_unverified=BUTTONS[button]), helper)
    assert not helper.errors and helper.done[0]['kind'] == 'applied', (helper.errors, helper.done)
    md = _created(client)
    assert md['prov'] == 'inferred' and md['provSource'] == SOURCE
    if button == 'unverified':
        assert 'provConfirmed' not in md, md
    else:
        assert md['provConfirmed'] is True, md
    conv, meta = store.load('c1')
    item = conv['display'][1]
    assert item['status'] == 'applied' and item['as_human'] is False
    assert bool(item.get('as_unverified')) is (button == 'unverified')
    note = conv['messages'][-1]['content']
    assert note.startswith('(note) The plan was approved as unverified and applied: 1 field value.'
                           if button == 'unverified' else '(note) The plan was approved and applied: 1 field value.')
    assert meta['pending'] is None


def test_the_box_wins_over_the_unverified_button():
    client = FakeClient()
    store = _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    _service().process_request(_req(client, 'approve', plan_id=PLAN1, as_human=True, as_unverified=True),
                               Helper(request_id='r9'))
    assert not {k for k in _created(client) if k.startswith('prov')}
    item = store.load('c1')[0]['display'][1]
    assert item['as_human'] is True and not item.get('as_unverified')


@pytest.mark.parametrize('button', sorted(BUTTONS))
def test_a_second_click_writes_nothing_again(button):
    client = FakeClient()
    _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    svc = _service()
    svc.process_request(_req(client, 'approve', plan_id=PLAN1, as_unverified=BUTTONS[button]), Helper('r9'))
    # The other button, pressed after the first answer came: written once.
    again = Helper(request_id='r10')
    svc.process_request(_req(client, 'approve', plan_id=PLAN1, as_unverified=not BUTTONS[button]), again)
    assert again.done[0]['duplicate'] is True
    assert len(client.payloads('spans.create')) == 1
    item = _settled_item(client)[2]
    assert bool(item.get('as_unverified')) is (button == 'unverified'), 'the first approval stands'


@pytest.mark.parametrize('button', sorted(BUTTONS))
def test_a_stale_card_is_refused_and_settled_out_of_date(button):
    client = FakeClient()
    store = _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    client._documents['d1']['version'] = 8
    helper = Helper(request_id='r9')
    _service().process_request(_req(client, 'approve', plan_id=PLAN1, as_unverified=BUTTONS[button]), helper)
    assert helper.errors and 'has changed since the plan was made' in helper.errors[0]
    assert not client.payloads('spans.create')
    item = store.load('c1')[0]['display'][1]
    assert item['status'] == 'stale' and 'as_unverified' not in item


@pytest.mark.parametrize('button', sorted(BUTTONS))
def test_a_partly_applied_plan_records_the_button(button):
    client = FakeClient()
    _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    svc = _service()
    real = svc.process_request
    svc.process_request = lambda req, h: real({**req, 'as_unverified': BUTTONS[button]}, h)
    item = _stop_partway(client, svc)
    assert item['status'] == 'partial' and item['written'] == [0]
    assert bool(item.get('as_unverified')) is (button == 'unverified') and item['as_human'] is False


@pytest.mark.parametrize('button', sorted(BUTTONS))
def test_a_failed_approval_writes_nothing_and_leaves_the_card_undecided(button):
    client = FakeClient()
    store = _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    svc = _service()
    from plaid_agent.core.plan import PlanError

    def execute(*a, **k):
        raise PlanError('the server refused', applied=0, total=1, written=[])
    svc.execute_plan = execute
    helper = Helper(request_id='r9')
    svc.process_request(_req(client, 'approve', plan_id=PLAN1, as_unverified=BUTTONS[button]), helper)
    assert helper.errors and 'Nothing was written' in helper.errors[0], helper.errors
    item = store.load('c1')[0]['display'][1]
    assert item['status'] is None and 'as_unverified' not in item


@pytest.mark.parametrize('button', sorted(BUTTONS))
def test_a_dead_run_settles_recorded_as_its_button(button):
    client = FakeClient()
    _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    svc = _service()
    real = svc.process_request
    svc.process_request = lambda req, h: real({**req, 'as_unverified': BUTTONS[button]}, h)
    import test_dead_approval
    made = test_dead_approval._service
    test_dead_approval._service = lambda: svc
    try:
        _die_while_applying(client, after_write=True)
    finally:
        test_dead_approval._service = made
    _service().process_request(_req(client, 'hold'), Helper(request_id='h1'))
    item = _settled_item(client)[2]
    assert item['status'] == 'partial'
    assert bool(item.get('as_unverified')) is (button == 'unverified') and item['as_human'] is False


@pytest.mark.parametrize('button', sorted(BUTTONS))
def test_another_tab_is_refused_while_the_hold_is_live(button):
    client = FakeClient()
    _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    svc = _service()
    # Tab a holds the conversation (any op from it takes a free hold).
    svc.process_request(_req(client, 'hold'), Helper(request_id='h1'))
    other = Helper(request_id='r9')
    svc.process_request(_req(client, 'approve', tab=OTHER_TAB, plan_id=PLAN1, as_unverified=BUTTONS[button]), other)
    assert other.done[0]['why'] == 'held', other.done
    assert not client.payloads('spans.create')


def _rows(ops):  # as an approval numbers them (``opkind.ROW``)
    return [{**op, ROW: i} for i, op in enumerate(ops)]


@pytest.mark.parametrize('mode', ['unverified', 'verified'])
def test_a_confirmation_confirms_under_either_button_in_either_app(mode):
    # The owner's ruling (2026-11-12): the person asked for those values to
    # be confirmed, and "unverified" is the stamp on what the assistant
    # writes, not a refusal of what the plan says.
    from plaid_client.testing import as_fragment
    from test_contributor_confirm import _igt_confirm_plan, _ud_ws
    from plaid_agent.igt.plan import execute_plan as igt_execute
    from plaid_agent.ud.plan import execute_plan as ud_execute
    from plaid_agent.ud.toolkit import call_tool as ud_call
    w = _igt_confirm_plan()
    counts = igt_execute(w.client, _rows(w.plan_payload()['ops']), source=SOURCE, label='l', project=w.project,
                         stamp_mode=mode)
    assert sorted(sid for sid, _ in w.client.patches('spans')) == ['sp-g1', 'sp-m1b']
    assert all(as_fragment(p) == {'provConfirmed': True} for _, p in w.client.patches('spans'))
    assert len(w.client.payloads('vocab_links.patch_metadata')) == 1
    assert counts['confirmations'] == 3 and 'unwritten' not in counts and 'notes' not in counts, counts
    ws = _ud_ws()
    ud_call(ws, 'confirm', {'document': 'Viaje', 'refs': ['s1.w4']})
    counts = ud_execute(ws.client, _rows(ws.plan_payload()['ops']), source=SOURCE, label='l', project=ws.project,
                        stamp_mode=mode)
    assert ws.client.patches('spans') and 'unwritten' not in counts, counts


@pytest.mark.parametrize('mode', ['unverified', 'contributed'])
def test_a_contributors_confirmation_records_what_a_contributors_confirm_records_under_either_button(mode):
    from plaid_client.testing import as_fragment
    from test_contributor_confirm import BOB, CONTRIBUTED_BY_BOB, _igt_confirm_plan
    from plaid_agent.igt.plan import execute_plan as igt_execute
    w = _igt_confirm_plan()
    counts = igt_execute(w.client, _rows(w.plan_payload()['ops']), source=SOURCE, label='l', project=w.project,
                         stamp_mode=mode, contributor=BOB)
    [(sid, patch)] = w.client.patches('spans')
    assert sid == 'sp-m1b' and as_fragment(patch) == CONTRIBUTED_BY_BOB
    assert counts['notes'] == ["1 annotation accepted as your contribution, 2 contributor's annotations left "
                               'for a reviewer']


@pytest.mark.parametrize('mode', ['unverified', 'verified'])
def test_a_mixed_plan_confirms_and_writes_its_values_as_the_button_says(mode):
    from plaid_client.testing import as_fragment
    from test_contributor_confirm import _igt_confirm_plan
    from plaid_agent.igt.plan import execute_plan as igt_execute
    from plaid_agent.igt.toolkit import call_tool as igt_call
    w = _igt_confirm_plan()
    out = igt_call(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'fish'})
    assert out.startswith('Planned'), out
    payload = w.plan_payload()
    assert 'stamp_choice' not in payload, 'a value the assistant writes: the two buttons'
    w.client.calls.clear()
    igt_execute(w.client, _rows(payload['ops']), source=SOURCE, label='l', project=w.project, stamp_mode=mode)
    confirmed = [p for _, p in w.client.patches('spans') if as_fragment(p) == {'provConfirmed': True}]
    assert len(confirmed) == 2, 'the confirmations are made under either button'
    made = [p['args'][3] for p in w.client.payloads('spans.create') if len(p.get('args') or []) > 3] + \
        [as_fragment(p) for sid, p in w.client.patches('spans') if as_fragment(p).get('prov')]
    assert made and all(m['prov'] == 'inferred' and m['provSource'] == SOURCE for m in made), made
    assert all(bool(m.get('provConfirmed')) is (mode == 'verified') for m in made), made


def test_a_plan_of_confirmations_only_offers_no_choice():
    from test_contributor_confirm import _igt_confirm_plan, _ud_ws
    from plaid_agent.ud.toolkit import call_tool as ud_call
    assert _igt_confirm_plan().plan_payload()['stamp_choice'] is False
    ws = _ud_ws()
    ud_call(ws, 'confirm', {'document': 'Viaje'})  # a scope over the document
    assert ws.plan_payload()['stamp_choice'] is False


def test_which_kinds_carry_no_stamp_choice_is_declared_per_kind():
    from plaid_agent.igt.plan import KIND as IGT
    from plaid_agent.ud.plan import KIND as UD
    from plaid_agent.umr.plan import KIND as UMR
    assert not IGT['confirm'].stamped and not UD['confirm'].stamped and not UD['confirm_scope'].stamped
    assert not UMR['delete_node'].stamped and not IGT['split_sentence'].stamped
    assert IGT['set_span'].stamped and UD['set_head'].stamped and UMR['create_node'].stamped
    # A kind that leaves the stamp to the approver says so by default.
    assert IGT['bulk_scope'].stamped and UD['del_relation'].stamped


def test_the_plan_contract_says_the_user_chooses_and_nothing_of_the_assistant_deciding():
    assert ('When they approve, the user chooses whether the changes are recorded as verified or as unverified '
            'proposals.') in PLAN_CONTRACT
    assert 'you chose' not in PLAN_CONTRACT and 'recorded as verified (made by you' not in PLAN_CONTRACT


@pytest.mark.parametrize('button', sorted(BUTTONS))
def test_a_contributors_approval_writes_their_contribution_or_the_assistants_proposal(button):
    # The project reviews the approver's work (the provenance convention's
    # contributor rule): "Approve as your contribution" (the card's verified
    # button for them) writes their contribution, never a verification, and
    # "Approve as unverified" leaves every change the assistant's proposal.
    client = FakeClient()
    store = _seed_plan(client, request_id=None)
    _set_meta(client, pending=None)
    svc = _service()
    svc._reviewed = lambda *a: True
    svc.process_request(_req(client, 'approve', plan_id=PLAN1, as_unverified=BUTTONS[button]), Helper('r9'))
    md = _created(client)
    assert 'provConfirmed' not in md, md
    item = store.load('c1')[0]['display'][1]
    if button == 'unverified':
        assert md['prov'] == 'inferred' and md['provSource'] == SOURCE
        assert item.get('as_unverified') is True and not item.get('contributed')
    else:
        assert md['prov'] == 'contributed' and md['provSource'] == 'user:u@x', md
        assert item.get('contributed') is True and not item.get('as_unverified')


def test_the_plan_contract_says_a_reviewed_users_verified_approval_is_their_contribution():
    assert ("Where the project reviews that user's work, what they approve as verified is their own contribution "
            'awaiting a reviewer.') in PLAN_CONTRACT
