"""A job that fills nothing (RPF-A5, the owner's R2): it does its work once
and shows its one report in full.

RP-4: a report-only job planned as one selection was walked again after its
piece in 20 stretches, each redoing the whole report, and every note was cut
to 400 characters, so the report itself was nowhere on the page. Now its
documents are done once its planned piece ran, and the piece's whole last
reply is the report's ``findings``."""

import pytest

from fixtures import FakeClient
from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.core import prompt as shared
from plaid_agent.core.job import run_job
from plaid_agent.core.limits import JOB_FINDINGS_MAX_CHARS, JOB_NOTE_MAX_CHARS
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.project import load_project
from plaid_agent.igt.prompt import build_job_prompt

J = 'JFN'
MERGE = "Write the job's one report now."
REPORT = '## Inconsistent glosses\n\n| form | glosses |\n|---|---|\n' + ''.join(
    f'| ka{i} | GO ({i}), go (1) |\n' for i in range(60)) + '\nThe rest agree.'


def _docs(n=2):
    return {f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['ka', 'ta']}, {'words': ['sa']}])
            for i in range(1, n + 1)}


def _model(piece, merged='One report.'):
    def answer(asked, n, kwargs):
        if asked.rstrip().endswith(MERGE):
            return reply(merged)
        if asked.rstrip().endswith('Write the summary now.'):
            return reply('Summary.')
        return piece(asked, n)
    return Model(answer)


def test_rp4_a_selection_that_fills_nothing_works_once_and_keeps_its_whole_report(monkeypatch):
    client = JobClient(_docs(2))
    job = start(client, 'List the glosses that disagree. Change nothing.', id=J, plan='selection', fills=())
    # The piece reads both documents, as RP-4's did: a check works by
    # reading, and a document it never read would be worked apart (round 2).
    model = use(monkeypatch, _model(lambda asked, n: reply(calls=[
        call(1, 'read_document', {'document': 'Story 1'}), call(2, 'read_document', {'document': 'Story 2'})])
        if n == 1 else reply(REPORT)))
    finished = run_job(job, runner(job))
    report = finished['report']
    assert len([c for c in model.calls if c['n'] == 1]) == 1, 'the selection, and no stretch after it'
    assert report['findings'] == REPORT, 'the whole report, once'
    assert len(REPORT) > JOB_NOTE_MAX_CHARS
    # Its note is not the findings flattened and shown twice (REV-RPF-P-10).
    assert [n['note'] for n in report['notes']] == [igt_job.FINDINGS_NOTE]
    assert igt_job.FINDINGS_NOTE == 'Its findings are in the report.'
    assert [(d['state'], d['done'], d['targets']) for d in report['documents']] == [('done', 2, 2), ('done', 2, 2)]
    assert report['plan']['fallback'] == [], 'no document worked in smaller pieces'
    assert report['summary'] is None or report['summary'] == 'The job wrote no change and proposed none.'


def test_a_selection_that_fills_something_is_still_walked_where_it_was_not_shown(monkeypatch):
    """NW's rule, unchanged: a sentence the selection was never shown is
    worked by the walk, a stretch of its own."""
    client = JobClient(_docs(1))
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan='selection')
    model = use(monkeypatch, _model(lambda asked, n: reply('Nothing read.')))
    finished = run_job(job, runner(job))
    assert len([c for c in model.calls if c['n'] == 1]) > 1
    assert 'findings' not in finished['report']


def test_several_pieces_findings_are_one_report_by_the_final_context(monkeypatch):
    client = JobClient(_docs(2))
    job = start(client, 'Summarize each text.', id=J, plan='document', fills=())
    model = use(monkeypatch, _model(lambda asked, n: reply(f'Text {asked.split(chr(34))[1]} is short.'),
                                    merged='Both texts are short.'))
    finished = run_job(job, runner(job, write_summary=True))
    assert finished['report']['findings'] == 'Both texts are short.'
    merge = [c for c in model.calls if c['asked'].rstrip().endswith(MERGE)]
    assert len(merge) == 1
    assert '## Story 1\n\nText Story 1 is short.' in merge[0]['asked'] and 'Text Story 2 is short.' in merge[0]['asked']


def test_several_pieces_findings_without_a_final_context_are_each_under_its_heading(monkeypatch):
    client = JobClient(_docs(2))
    job = start(client, 'Summarize each text.', id=J, plan='document', fills=())
    use(monkeypatch, _model(lambda asked, n: reply(f'Text {asked.split(chr(34))[1]} is short.')))
    finished = run_job(job, runner(job))
    assert finished['report']['findings'] == ('## Story 1\n\nText Story 1 is short.\n\n'
                                              '## Story 2\n\nText Story 2 is short.')
    assert (finished['report']['findings_pieces'], finished['report']['findings_cut']) == (2, 0)


def test_findings_too_long_for_the_final_context_are_never_merged_and_say_what_did_not_fit(monkeypatch):
    """REV-RPF-W-2: 80 pieces, each with 1,100 characters of findings, do not
    fit whole in what the final context is handed (JOB_FINDINGS_MERGE_CHARS).
    The final context is not asked (it would have silently dropped a quarter
    of the documents): the report keeps each piece's findings under its
    heading in document order, cut where the cap is reached with the cut
    line, and says how many pieces it holds and how many did not fit."""
    n = 80
    client = JobClient(_docs(n))
    job = start(client, 'List what is odd in each text.', id=J, plan='document', fills=())
    model = use(monkeypatch, _model(lambda asked, k: reply(f'FINDING-{asked.split(chr(34))[1]}: ' + 'x' * 1100)))
    report = run_job(job, runner(job, write_summary=True))['report']
    assert not [c for c in model.calls if c['asked'].rstrip().endswith(MERGE)], 'no merge that cannot see them all'
    findings = report['findings']
    assert findings.endswith(igt_job.FINDINGS_CUT)
    order = [d['name'] for d in report['documents']]
    shown = [name for name in order if f'## {name}\n' in findings]
    assert shown == order[:len(shown)] and len(shown) < n, 'in the job\'s order, cut at the end'
    # Only whole pieces: no heading left with nothing under it (REV-RPF2-4).
    assert all(f'FINDING-{name}: ' + 'x' * 1100 in findings for name in shown)
    assert report['findings_pieces'] == n
    assert report['findings_cut'] == n - len(shown) > 0
    # Each piece's findings are on its own row of the work list, so none is
    # out of reach (REV-RPF2-4).
    rows = [p['piece'] for p in client.jobs.pieces(J) if p['piece'].get('document')]
    assert len(rows) == n and all(r['findings'] == f'FINDING-{r["name"]}: ' + 'x' * 1100 for r in rows)


def test_a_pieces_findings_on_its_row_are_cut_to_the_rows_cap_and_say_so():
    """A piece's findings on its summary row are held to the row's cap
    (JOB_ANALYSIS_MAX_CHARS, the whole row as JSON) and cut at a line or a
    sentence end with a line of their own saying so."""
    from plaid_agent.core.limits import JOB_ANALYSIS_MAX_CHARS
    import json
    value = {'piece': 'k', 'document': 'd1', 'name': 'Story', 'note': igt_job.FINDINGS_NOTE,
             'findings': 'A finding on a line of its own.\n' * 400}
    text = igt_job.summary_text(value)
    assert len(text) <= JOB_ANALYSIS_MAX_CHARS
    kept = json.loads(text)['findings']
    assert kept.endswith('own.\n\n' + igt_job.PIECE_FINDINGS_CUT) and len(kept) > 2000


def test_findings_that_fit_are_merged_and_carry_no_cut_count(monkeypatch):
    client = JobClient(_docs(2))
    job = start(client, 'Summarize each text.', id=J, plan='document', fills=())
    use(monkeypatch, _model(lambda asked, n: reply('Short.'), merged='Both texts are short.'))
    report = run_job(job, runner(job, write_summary=True))['report']
    assert report['findings'] == 'Both texts are short.'
    assert 'findings_pieces' not in report and 'findings_cut' not in report


def test_a_job_that_fills_something_has_no_findings(monkeypatch):
    client = JobClient(_docs(1))
    job = start(client, 'Gloss.', id=J, plan='document')
    use(monkeypatch, _model(lambda asked, n: reply('Glossed nothing.')))
    assert 'findings' not in run_job(job, runner(job))['report']


def test_findings_past_the_cap_are_cut_at_a_line_and_say_so():
    text = ('A finding on a line of its own.\n' * 2000)
    out = igt_job.findings_text(text)
    assert len(out) <= JOB_FINDINGS_MAX_CHARS
    assert out.endswith('own.\n\n(The rest of this report is cut.)')
    assert igt_job.findings_text('Short.') == 'Short.'


def test_findings_are_kept_over_as_many_rows_as_they_need():
    rows = igt_job.findings_rows('k', {'document': 'd1', 'name': 'Story', 'sentences': None}, REPORT * 5)
    assert len(rows) > 1 and all(len(r['analysis']) <= 4000 for r in rows)
    import json
    assert ''.join(json.loads(r['analysis'])['text'] for r in rows) == REPORT * 5


def test_a_piece_of_a_plan_that_fills_nothing_ends_with_its_findings():
    project = load_project(FakeClient(), 'p1')
    for sentences in (False, True):
        out = build_job_prompt(project, sentences=sentences, findings=True)
        assert shared.JOB_FINDINGS_NOTE in out and shared.JOB_NOTE not in out
        assert shared.JOB_NOTE in build_job_prompt(project, sentences=sentences)


@pytest.mark.parametrize('pieces', ['document', 'selection'])
def test_the_piece_of_a_plan_that_fills_nothing_is_told_so(monkeypatch, pieces):
    client = JobClient(_docs(1))
    job = start(client, 'List the glosses.', id=J, plan=pieces, fills=())
    model = use(monkeypatch, _model(lambda asked, n: reply(REPORT)))
    run_job(job, runner(job))
    assert shared.JOB_FINDINGS_NOTE in model.calls[0]['kwargs']['messages'][0]['content']
