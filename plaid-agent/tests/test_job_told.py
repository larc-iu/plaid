"""What a job's model and a job's reader are told (job review 2026-11-18, lane JR2).

Each test pins one false statement the review found, by what the model or
read_job is shown, on the fake."""

from fixtures import FakeClient

from plaid_agent.igt import toolkit
from plaid_agent.igt.job import JobWorkspace
from plaid_agent.igt.project import load_project


def _job_ws():
    c = FakeClient()
    return JobWorkspace(c, load_project(c, 'p1'))


# --- D8: a rule or a setup change is proposed, never applied -------------------------------------

def test_a_rule_staged_in_a_job_is_told_as_proposed_with_no_card_and_no_user():
    ws = _job_ws()
    out = toolkit.job_piece_call(ws, 'replace_in_field', {'field': 'Gloss', 'pattern': 'Ali', 'replacement': 'ALI'})
    assert [o['kind'] for o in ws.ops] == ['bulk_scope']
    assert out.startswith('Staged 1 value in 1 document. 1 proposed change in all, listed in the report and '
                          'never applied.')
    for chat in ('applied when you end', 'card', 'approve'):
        assert chat not in out
    assert ws.result_line() == '[Staged: 0 changes to apply, 1 proposed change only listed in the report.]'


def test_a_setup_change_beside_a_value_is_counted_apart_from_it():
    ws = _job_ws()
    out = toolkit.job_piece_call(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1'], 'field': 'Gloss',
                                                   'value': 'x'})
    assert out.startswith('Staged 1 change. 1 change staged in all, applied when you end.')
    assert ws.result_line() == '[Staged: 1 change.]'
    out = toolkit.job_piece_call(ws, 'guidelines', {'action': 'add', 'title': 'T', 'body': 'x'})
    assert out.startswith('Staged 1 change. 1 proposed change in all, listed in the report and never applied. '
                          '1 change staged in all, applied when you end.')
    assert ws.result_line() == '[Staged: 1 change to apply, 1 proposed change only listed in the report.]'
    status = toolkit.job_piece_call(ws, 'plan_status', {})
    assert 'approve' not in status and status.splitlines()[0] == '2 planned changes:'

