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


# --- D9: a job that stands undone says so ---------------------------------------------------------

UNDONE = {'operation': 'op-1', 'time': '2026-11-18T03:10:00Z', 'user': 'u1'}


def _undone_job():
    return {'id': 'j1', 'project': 'p1', 'state': 'done', 'undone': UNDONE, 'created_at': '2026-11-18T01:00:00Z',
            'started_by': 'u1', 'documents': ['d1'], 'instructions': 'Gloss.',
            'report': {'notice': "People's work: 3 values people wrote were changed.",
                       'totals': {'changes': 40}, 'documents': []}}


def test_read_job_says_an_undone_job_is_undone_and_drops_its_notice():
    from plaid_agent.igt.jobread import summary
    lines = summary(_undone_job())
    assert lines[0] == 'State: done, undone 2026-11-18 03:10 UTC.'
    said = '\n'.join(lines)
    assert "People's work" not in said
    assert 'Undone 2026-11-18 03:10 UTC: the counts below are what the job had written, not what stands now.' in lines


def test_the_list_of_jobs_says_which_stand_undone():
    from plaid_agent.igt.jobread import _list_jobs

    class _Jobs:
        def list(self, project):
            return [{**_undone_job(), 'document_count': 1}, {**_undone_job(), 'id': 'j2', 'undone': None}]

    class _Ws:
        client = type('C', (), {'jobs': _Jobs()})()
        project = type('P', (), {'id': 'p1'})()

        def note_read(self, *a, **k):
            pass

    out = _list_jobs(_Ws(), 1)
    assert 'j1 | done, undone 2026-11-18 03:10 UTC |' in out
    assert 'j2 | done |' in out
