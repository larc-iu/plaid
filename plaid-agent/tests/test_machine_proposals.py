"""Machine proposals for judged work (the owner's ruling, 2026-11-12).

A value the user wrote in the message of the turn that staged it was asked
for by value, and an approved plan records it as confirmed, as before. Any
other value the assistant chose, and approval writes it as the assistant's
machine proposal: prov inferred, the assistant its source, no provConfirmed,
for the grid and confirm to treat as any service's proposal. "Record as
human-made" wins over both. A change that writes no value is unaffected. The
rule is fixed and dumb on purpose: the exact text, in this turn's message.
"""
import sys

sys.path.insert(0, 'tests')

from fixtures import FakeClient, fake_ws  # noqa: E402
from test_job_stamps import _metadata_written  # noqa: E402
from test_nothing_planned import _reply, _run, APPS  # noqa: E402

from plaid_agent.core.plan import PROPOSAL, Stamps, mark_proposal, written_values  # noqa: E402
from plaid_agent.core.prompt import PLAN_CONTRACT  # noqa: E402
from plaid_agent.igt.plan import execute_plan  # noqa: E402
from plaid_agent.igt.toolkit import call_tool  # noqa: E402

SOURCE = 'service:igt:assist:m'
DETAIL = {'model': 'm', 'version': 'v'}


def _staged(asked, *calls):
    ws = fake_ws(FakeClient())
    ws.user_message = asked
    for name, args in calls:
        assert call_tool(ws, name, args).startswith('Planned'), name
    return ws


GLOSS_X = ('set_field', {'document': 'Text 1', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'fish'})
GLOSS_Y = ('set_field', {'document': 'Text 1', 'refs': ['s1.w3'], 'field': 'Gloss', 'value': 'saw'})


def test_a_value_the_user_wrote_is_theirs_and_one_the_assistant_chose_is_a_proposal():
    ws = _staged('Gloss gam as fish and gloss the verb.', GLOSS_X, GLOSS_Y)
    by_value = {op['value']: op for op in ws.ops}
    assert not by_value['fish'].get(PROPOSAL)
    assert by_value['saw'][PROPOSAL] is True


def test_the_rule_reads_every_value_a_change_writes_and_nothing_else():
    keys = fake_ws(FakeClient()).VALUE_KEYS
    op = {'kind': 'set_analysis', 'label': 'Text 1 s1.w3', 'word_id': 'w-3', 'morphemes': [
        {'form': 'aku', 'type': 'stem', 'fields': [{'layer_id': 'l', 'value': 'see'}]},
        {'form': 'na', 'type': 'suffix', 'fields': [{'layer_id': 'l', 'value': 'PST'}]}]}
    assert written_values(op, keys) == ['aku', 'see', 'na', 'PST']
    mark_proposal(op, 'segment it as aku-na, glossed see-PST', keys)
    assert PROPOSAL not in op
    mark_proposal(op, 'segment it as aku-na', keys)
    assert op[PROPOSAL] is True, 'one value the user did not write makes the change a proposal'
    # A change that writes no value, and a turn with no message known.
    gone = {'kind': 'delete_word', 'token_id': 'w-1', 'label': 'x'}
    mark_proposal(gone, 'anything', keys)
    assert PROPOSAL not in gone
    mark_proposal(op, None, keys)
    assert op[PROPOSAL] is True, 'nothing is re-marked without a message'


def test_approval_writes_a_proposal_unconfirmed_and_the_users_value_confirmed():
    ws = _staged('Gloss gam as fish and gloss the verb.', GLOSS_X, GLOSS_Y)
    c = ws.client
    c.calls.clear()
    execute_plan(c, ws.plan_payload()['ops'], source=SOURCE, label='Assistant', project=ws.project,
                 stamp_mode='verified', detail=DETAIL)
    written = {p['args'][2]: p['args'][3] for p in c.payloads('spans.create') if len(p.get('args') or []) > 3}
    assert written['fish'].get('provConfirmed') is True and written['fish']['prov'] == 'inferred'
    assert written['saw']['prov'] == 'inferred' and written['saw']['provSource'] == SOURCE
    assert 'provConfirmed' not in written['saw'], 'the assistant\'s choice stays unconfirmed'


def test_record_as_human_made_wins_over_both():
    ws = _staged('Gloss gam as fish and gloss the verb.', GLOSS_X, GLOSS_Y)
    c = ws.client
    c.calls.clear()
    execute_plan(c, ws.plan_payload()['ops'], source=SOURCE, label='Assistant', project=ws.project,
                 stamp_mode='human', detail=DETAIL)
    assert not [md for md in _metadata_written(c) if md and 'prov' in md]


def test_a_proposal_is_stamped_without_a_job_and_the_jobs_refusal_stands():
    # The interactive case stamps beside the job's mode: the job's mode still
    # refuses to stamp without the job's id.
    s = Stamps('verified', SOURCE, detail=DETAIL)
    assert s.stamp({PROPOSAL: True}) == {'prov': 'inferred', 'provSource': SOURCE, 'provDetail': DETAIL}
    assert s.stamp({})['provConfirmed'] is True
    assert s.restamp({PROPOSAL: True})['provConfirmed'] is None
    import pytest
    with pytest.raises(ValueError, match='job'):
        Stamps('machine', SOURCE, detail=DETAIL)


def test_the_card_counts_both():
    ws = _staged('Gloss gam as fish and gloss the verb.', GLOSS_X, GLOSS_Y)
    assert ws.plan_payload()['proposals'] == {'chosen': 1, 'given': 1}
    ws = _staged('Gloss gam as fish.', GLOSS_X)
    assert 'proposals' not in ws.plan_payload()


def test_the_turn_marks_against_the_users_message(monkeypatch):
    ws, kit, plan, _read = APPS['igt']()
    out, _sent = _run(monkeypatch, ws, kit, [_reply(plan), _reply(text='Planned.')])
    # The scripted user wrote "x", and the plan sets Gloss to "X".
    assert ws.ops[0][PROPOSAL] is True


def test_the_plan_contract_says_what_approval_records():
    assert 'recorded as verified' not in PLAN_CONTRACT
    assert 'A change whose values you chose is recorded as your proposal' in PLAN_CONTRACT
