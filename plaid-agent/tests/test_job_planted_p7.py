"""Planted-faults campaign PF, lane 7 (2026-11-19): the job worker's command
(``jobworker.py``), what a turn and ``read_job`` say of a job
(``igt/jobread.py``), each test catching a fault the job test set let
through."""

from test_job_discuss import _ended, _report, _ws
from test_job_worker import _start

from plaid_agent.core.agent import ModelTooSlow
from plaid_agent.igt import jobread
from plaid_agent.igt.toolkit import call_tool


def test_a_worker_whose_opening_ping_is_too_slow_runs_anyway(monkeypatch, capsys):
    """A model too slow to answer the startup ping in time is not a model
    typed wrong: the worker goes on to ask core for jobs, with no wait."""
    out, waits, pings = _start(monkeypatch, [ModelTooSlow()])
    assert out is None, 'it went on to ask core for jobs'
    assert waits == [] and len(pings) == 1
    assert 'Running anyway' in capsys.readouterr().out


def test_a_ceiling_of_zero_given_on_the_command_line_means_none():
    """``--piece-output-tokens 0`` is how the help says "none": taken, not refused."""
    from plaid_agent import jobworker
    args = jobworker.parser().parse_args(['--url', 'u', '--model', 'm', '--piece-output-tokens', '0'])
    assert args.piece_output_tokens == 0


def test_an_error_that_names_the_models_host_never_shows_it_in_the_jobs_line():
    """The worker's secrets hold the model's host as well as its address, so
    an error of no rule that names the host bare (no URL) keeps it out of the
    line every reader of the job sees."""
    from plaid_agent.core.job import error_line
    from plaid_agent.jobworker import job_secrets
    line = error_line(OSError('Cannot connect to host llm.internal.org:8443 (refused)'),
                      job_secrets(None, 'https://llm.internal.org:8443/v1'))
    assert 'llm.internal.org' not in line, line


def test_the_worker_main_builds_waits_for_the_model_key_it_is_given(monkeypatch, tmp_path):
    """``--model-pool`` reaches the worker main() builds, so its jobs wait
    while people use the model (the prod worker's line names one)."""
    import litellm as _litellm
    from plaid_agent import jobworker
    monkeypatch.setattr(_litellm, 'suppress_debug_info', _litellm.suppress_debug_info)
    monkeypatch.setattr(_litellm, 'completion', _litellm.completion)
    monkeypatch.setattr(jobworker.BaseService, 'get_client', staticmethod(lambda url: object()))
    built = {}

    class Recorded:
        worker_id = 'w'

        def __init__(self, admin, runners, model, **kwargs):
            built.update(kwargs)

        def once(self):
            pass
    monkeypatch.setattr(jobworker, 'Worker', Recorded)
    path = tmp_path / 'model.json'
    path.write_text('[{"content": "Done."}]')
    assert jobworker.main(['--url', 'http://localhost:1', '--model', 'fake/m', '--scripted-model', str(path),
                           '--model-pool', 'reallms', '--once']) == 0
    assert built['pool'] == 'reallms'


def test_a_part_list_the_report_cut_whole_is_still_a_section_with_its_count():
    """``fit_report`` may cut every row of a list to fit core's cap and count
    them all in ``*_more``: the section is still named with its count, and
    read_job reads it as rows it did not list."""
    ws = _ws()
    report = _report(harmonize={'changed': [], 'left': [], 'changed_more': 900, 'left_more': 0})
    job = _ended(ws.client, report)
    _, _, said = jobread.job_place(ws, {'kind': 'job', 'id': job})
    assert 'Analyses made consistent (harmonize.changed) 900' in said, said
    out = call_tool(ws, 'read_job', {'job': job, 'section': 'harmonize.changed'})
    assert ': no rows, and 900 more the report counted and did not list.' in out, out


def test_the_rows_each_document_did_not_list_are_summed_over_the_documents():
    """Blank (left) in two documents, each with rows it counted and did not
    list: the section's count is every row of both."""
    ws = _ws()
    one = _report()['documents'][0]
    two = {**one, 'document_id': 'd2', 'name': 'Text 2',
           'left': [{'ref': 's1.w1', 'sentence_id': 'T1', 'begin': 0, 'form': 'kai'}], 'left_more': 5}
    job = _ended(ws.client, _report(documents=[{**one, 'left_more': 3}, two]))
    _, _, said = jobread.job_place(ws, {'kind': 'job', 'id': job})
    assert 'Blank (left) 10' in said, said
    out = call_tool(ws, 'read_job', {'job': job, 'section': 'left'})
    assert 'rows 1 to 2 of 2, and 8 more the report counted and did not list' in out, out


def test_a_turn_from_a_failed_jobs_page_is_given_its_summary():
    """A failed job has ended: its page's turn is given the summary, as a
    done or cancelled one's is, not the fixed line of a running job."""
    from test_job_discuss import WORKER
    ws = _ws()
    made = ws.client.jobs.create('p1', 'igt', 'Gloss ka as "go".', ['d1'])
    ws.client.jobs.claim(WORKER, 'm', ['igt'])
    ws.client.jobs.finish(made['id'], WORKER, 'failed', _report(state='failed'), reason='model-refused')
    _, _, said = jobread.job_place(ws, {'kind': 'job', 'id': made['id']})
    assert 'Its record as read now:' in said and 'State: failed (model-refused).' in said, said
    assert 'Report sections and their rows:' in said, said
