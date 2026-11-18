"""What a job's model and a job's reader are told (job review 2026-11-18, lane JR2).

Each test pins one false statement the review found, by what the model or
read_job is shown, on the fake."""

import pytest

from fixtures import FakeClient
from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_client import PlaidAPIError
from plaid_agent.core import job as core_job
from plaid_agent.core.limits import JOB_CORE_TRIES, JOB_DEFER_ROUNDS, JOB_DEFER_WAIT_S

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


# --- D14: core out of reach is not people editing -------------------------------------------------

def _two_documents(monkeypatch, down_reads):
    """A job over two documents whose reads of d1 meet a 502 the first
    ``down_reads`` times, on a fake clock."""
    clock = {'t': 1_800_000_000.0}
    docs = {f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['blank']}]) for i in (1, 2)}
    client = JobClient(docs)
    job = start(client, now=lambda: clock['t'])

    def sleep(s):
        clock['t'] += s
    job._sleep = sleep

    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[call(1, 'set_analysis', {'document': asked.split('"')[1], 'ref': 's1.w1',
                                                         'morphemes': [{'form': 'blank'}]})])
        return reply('Done.')
    use(monkeypatch, Model(answer))
    r = runner(job)
    real, left = r.read, {'n': down_reads}

    def read(project, document_id, client=None):
        if document_id == 'd1' and left['n']:
            left['n'] -= 1
            raise PlaidAPIError('HTTP 502 Bad Gateway', status=502, method='GET')
        return real(project, document_id, client)
    r.read = read
    return client, job, r


def _said(client):
    return [b.get('message') for k, b in client.jobs.calls if k == 'heartbeat' and b.get('message')]


def test_a_document_core_did_not_answer_for_is_waited_for_as_such_and_finished_after(monkeypatch):
    client, job, r = _two_documents(monkeypatch, JOB_CORE_TRIES)
    r.work(job)
    assert job.rows['d1']['state'] == 'done' and job.rows['d2']['state'] == 'done'
    assert not job.rows['d1'].get('defers')
    said = _said(client)
    assert not [m for m in said if m.startswith('Waiting for people')], said
    assert 'The server did not answer. Trying again in 10 minutes.' in said
    assert job.paused['edits'] == 0, "not a wait for people's edits"


def test_core_out_of_reach_for_good_ends_the_document_not_reached_never_in_use(monkeypatch):
    """Put off by core as often as a person's document would be before it
    ends in use, it ends not reached, and the job goes on (REV-JG-4)."""
    client, job, r = _two_documents(monkeypatch, 10 ** 6)
    r.work(job)
    assert job.rows['d1']['state'] == 'not-reached' and not job.rows['d1'].get('defers')
    assert job.rows['d2']['state'] == 'done'
    assert job.paused['edits'] == 0
    waits = [m for m in _said(client) if m == 'The server did not answer. Trying again in 10 minutes.']
    assert len(waits) == JOB_DEFER_ROUNDS and JOB_DEFER_WAIT_S == 600
    assert not [m for m in _said(client) if m.startswith('Waiting for people')]


@pytest.mark.parametrize('status,person', [(502, False), (429, False), (423, True)])
def test_a_put_off_by_core_names_its_error_and_a_lock_names_a_person(monkeypatch, status, person):
    """The selection's write and the walk put a document off through one
    helper: a lock (423) is a person in the document, anything else core
    could not answer is not, and the selection records the fallback
    reason by it."""
    from plaid_agent.igt.job import Deferred
    client, job, r = _two_documents(monkeypatch, 0)

    def step():
        raise PlaidAPIError('refused', status=status, method='POST')
    with pytest.raises(Deferred) as e:
        r.off_on_trouble('d1', step)
    assert (e.value.error is None) is person


# --- D10: core's own report, read as the page reads it --------------------------------------------

def test_read_job_says_the_words_core_s_own_report_holds_in_its_documents_and_whose_line_it_is():
    from plaid_agent.igt.jobread import summary
    job = {'id': 'j1', 'project': 'p1', 'state': 'cancelled', 'documents': ['d1'], 'instructions': 'Respell.',
           'report': {'totals': {'text_changes': 3, 'peoples_values_changed': 0},
                      'documents': [{'state': 'done', 'counts': {'words_added': 25, 'tokens_changed': 2,
                                                                 'text_changes': 3}}]}}
    top = next(line for line in summary(job) if line.startswith("The report's top line"))
    assert top == ('The report\'s top line: "Text: 25 words added, 2 existing words or punctuation marks changed or '
                   'removed."'), top

