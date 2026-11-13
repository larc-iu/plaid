"""The report a job stores at its finish (SPEC 9, CONTRACT 5.3): lists, never
a map keyed by an id, each cut at 500 with a count of the rest."""

from job_fixtures import JobClient, Model, document, reply, runner, start, use

from plaid_agent.core.job import build_report, run_job
from plaid_agent.core.limits import JOB_REPORT_LIST_MAX
from plaid_agent.igt.job import entries_part

KEYS = {'state', 'reason', 'instructions', 'started_by', 'model', 'started_at', 'finished_at',
        'paused_for_people_s', 'paused_for_model_s', 'stopped', 'totals', 'documents', 'harmonize', 'entries',
        'summary', 'summary_failed'}


def _job():
    client = JobClient({'d1': document('d1', 'One', [{'words': ['a']}]),
                        'd2': document('d2', 'Two', [{'words': ['b']}])})
    return client, start(client, instructions='Gloss loans whole.')


def _maps_keyed_by(value, ids, path='report'):
    """Every dict in ``value`` with an id among its keys."""
    out = []
    if isinstance(value, dict):
        out += [path] if set(value) & ids else []
        for k, v in value.items():
            out += _maps_keyed_by(v, ids, f'{path}.{k}')
    elif isinstance(value, list):
        for i, v in enumerate(value):
            out += _maps_keyed_by(v, ids, f'{path}[{i}]')
    return out


def test_the_report_has_the_contracts_shape_and_cuts_its_lists():
    client, job = _job()
    job.update_row('d1', state='done', sentences=4, targets=3, done=3,
                   counts={'translations': 0, 'refreshed': 0, 'words': 5, 'links': 4, 'entries': 1, 'left': 1,
                           'changed': 1, 'proposed': 0, 'analyzed': 2},
                   skipped=[{'sentence': 's4', 'sentence_id': 'x', 'reason': 'too-long', 'kind': None}])
    job.update_row('d2', state='in-use')
    created = [{'id': f'e{i}', 'lexicon': 'v1' if i < JOB_REPORT_LIST_MAX else 'v2', 'form': f'f{i}', 'gloss': 'g'}
               for i in range(JOB_REPORT_LIST_MAX + 3)]
    report = build_report(job, 'done', None, runner(job).document_reports(job),
                          {'changed': [{'form': 'ka', 'to': 'ka ‘go’', 'by': 'majority', 'from': []}], 'left': []},
                          entries_part(created, []))
    assert set(report) == KEYS
    assert report['instructions'] == 'Gloss loans whole.' and 'tasks' not in report
    assert report['stopped'] is None
    t = report['totals']
    assert (t['documents_done'], t['documents_in_use'], t['documents_not_reached']) == (1, 1, 0)
    # "sentences" is the sentences analysed (``analyzed``), not those done.
    assert (t['sentences'], t['words'], t['links'], t['changed'], t['skipped_too_long']) == (2, 5, 4, 1, 1)
    assert t['entries'] == JOB_REPORT_LIST_MAX + 3, 'counted whole, listed cut'
    assert len(report['entries']['created']) == JOB_REPORT_LIST_MAX and report['entries']['created_more'] == 3
    assert {e['lexicon'] for e in report['entries']['created']} == {'v1'}
    assert report['entries']['lexicons'] == ['v1', 'v2'], 'every lexicon it created in, the cut ones too'
    assert report['harmonize']['changed_more'] == 0 and report['harmonize']['left_more'] == 0
    assert [d['document_id'] for d in report['documents']] == ['d1', 'd2']
    assert report['documents'][1]['state'] == 'in-use'
    assert not _maps_keyed_by(report, {'d1', 'd2', 'v1', 'e1', job.id})


def test_a_job_run_to_its_end_stores_its_report_and_is_done(monkeypatch):
    client, job = _job()
    use(monkeypatch, Model(lambda asked, n, kwargs: reply('Done.')))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    stored = client.jobs.rows[job.id]['report']
    assert stored['state'] == 'done' and stored['totals']['documents_done'] == 2
    assert [d['state'] for d in stored['documents']] == ['done', 'done']


def test_a_failed_check_ends_the_job_failed_with_its_reason_and_message(monkeypatch):
    client = JobClient({'d1': document('d1', 'One', [{'words': ['a']}])})
    client.projects.guidelines = lambda project_id, **kw: [{'id': 'g1', 'title': 'All', 'body': 'x' * 25000}]
    job = start(client)
    from plaid_agent.igt import job as igt_job
    real = igt_job.manual_chars
    igt_job.manual_chars = lambda g: 25000
    try:
        finished = run_job(job, runner(job))
    finally:
        igt_job.manual_chars = real
    assert finished['state'] == 'failed' and finished['reason'] == 'guidelines-too-long'
    assert client.jobs.rows[job.id]['message'] == ("The project's guidelines are 25,000 characters. A job reads at "
                                                   'most 24,000.')


# --- the report always fits core's cap (REV-JG-2) ----------------------------------------------

def _bytes(report):
    """The report's size as core measures it: its JSON, every character
    written as itself, in UTF-8."""
    import json
    return len(json.dumps(report, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))


def test_a_job_whose_code_kept_tables_at_every_cap_ends_done_with_a_report_that_fits(monkeypatch):
    """REV-JG-2, the review's case: four document pieces, each piece's code
    keeping five tables within every cap table() has. The report would be
    about 2 MB: the tables that do not fit are dropped, the report counts
    them, and the job ends done."""
    import pytest
    from job_fixtures import call
    from plaid_agent.core import sandbox
    if sandbox.available() is not None:
        pytest.skip('the code sandbox is not installed')
    docs = {f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['ka']}]) for i in range(1, 5)}
    client = JobClient(docs)
    job = start(client, 'Report every form and its glosses.', plan='document')
    code = ('for t in range(5):\n'
            '    table("Forms " + str(t), ["a","b","c","d","e","f","g","h"], [["x" * 120] * 8 for _ in range(200)])\n'
            'print("ok")')

    def piece(asked, n, kwargs):
        if n == 1:
            return reply(calls=[call(1, 'run_code', {'code': code})])
        return reply('Counted.')
    use(monkeypatch, Model(piece))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished['state'], finished.get('reason'), finished.get('message'))
    report = finished['report']
    from plaid_agent.core.limits import JOB_REPORT_MAX_BYTES
    assert _bytes(report) <= JOB_REPORT_MAX_BYTES
    assert report['tables'] and report['tables_more'] > 0
    from plaid_agent.igt.job import TABLE_FORM
    made = {f[len(TABLE_FORM):].rsplit(' ', 1)[0] for (f, _), _r in client.jobs.decision_rows[job.id].items()
            if f.startswith(TABLE_FORM)}
    assert len(report['tables']) + report['tables_more'] == len(made), 'every table kept is listed or counted'


def _huge_report():
    """A report holding every list at its cap, each row long, in Cyrillic."""
    from plaid_agent.core.job import build_report
    client, job = _job()
    long = 'я' * 290
    row = {'kind': 'set_span', 'document_id': 'd1', 'document': long, 'ref': 's1.w1', 'field': 'Gloss',
           'from': long, 'to': long, 'label': long, 'note': long}
    docs = []
    for i in range(500):
        docs.append({'document_id': f'doc-{i}', 'name': long, 'state': 'done', 'sentences': 9, 'targets': 9,
                     'done': 9, 'counts': {'words': 1, 'left': 500}, 'gloss_group': None, 'harmonize_group': None,
                     'skipped': [{'sentence': f's{k}', 'sentence_id': f'{i}-{k}', 'reason': 'failed',
                                  'kind': 'budget'} for k in range(500)],
                     'left': [{'ref': f's{k}.w1', 'sentence_id': f'{i}-{k}', 'begin': k, 'form': long[:40]}
                              for k in range(500)], 'left_more': 0})
    harmonize = {'changed': [{'form': long, 'to': long, 'by': 'majority',
                              'from': [{'analysis': long, 'count': 2, 'documents': ['d1']}]}] * 500,
                 'left': [{'form': long, 'reason': 'touched', 'analyses': [{'analysis': long, 'count': 1}]}] * 500}
    entries = {'created': [{'id': 'e', 'lexicon': 'v1', 'form': long, 'gloss': long}] * 500,
               'unlinked': [], 'lexicons': ['v1']}
    report = build_report(job, 'done', None, docs, harmonize, entries)
    report.update({'proposed': [dict(row) for _ in range(500)], 'proposed_more': 0,
                   'notes': [{'document': 'd1', 'name': long, 'sentences': 's1', 'note': 'я' * 400}] * 500,
                   'notes_more': 0, 'tables': [{'title': long, 'columns': ['a'] * 8,
                                                 'rows': [[long[:120]] * 8] * 200, 'more': 0}] * 20,
                   'summary': 'я' * 3000})
    return report


def test_a_report_of_every_list_at_its_cap_is_cut_to_fit_and_counts_what_it_cut():
    """Every list of a report at its cap at once, in Cyrillic: tables go
    first, then notes, then proposed changes, then each document's lists,
    and each count of what is not listed grows by what was cut."""
    from plaid_agent.core.job import fit_report
    from plaid_agent.core.limits import JOB_REPORT_BUDGET_BYTES
    report = _huge_report()
    before = {'tables': len(report['tables']), 'notes': len(report['notes']), 'proposed': len(report['proposed']),
              'skipped': report['totals']['skipped_failed'], 'left': sum(len(d['left']) for d in report['documents'])}
    fit_report(report)
    assert _bytes(report) <= JOB_REPORT_BUDGET_BYTES
    assert report['tables'] == [] and report['tables_more'] == before['tables']
    assert report['notes'] == [] and report['notes_more'] == before['notes']
    assert len(report['proposed']) + report['proposed_more'] == before['proposed']
    t = report['totals']
    assert t['skipped_failed'] + t['skipped_more'] == before['skipped'], 'a skipped sentence cut is counted as more'
    assert t['skipped_failed'] == sum(len(d['skipped']) for d in report['documents'])
    assert sum(len(d['left']) + d['left_more'] for d in report['documents']) == before['left']
    assert report['summary'] == 'я' * 3000, 'the prose is never cut'
    assert len(report['documents']) == 500


def test_a_report_that_fits_is_left_whole():
    from plaid_agent.core.job import fit_report
    client, job = _job()
    report = build_report(job, 'done', None, runner(job).document_reports(job), {'changed': [], 'left': []},
                          entries_part([], []))
    report.update({'tables': [{'title': 't', 'columns': ['a'], 'rows': [['1']], 'more': 0}], 'notes': [],
                   'proposed': []})
    whole = __import__('copy').deepcopy(report)
    fit_report(report)
    assert report == {**whole, 'tables_more': 0}


# --- a row the job keeps always fits core's cap (REV-JG-12, REV-JG-20) -------------------------

def test_a_table_cell_holding_a_huge_number_is_cut_as_text_is():
    """REV-JG-12: code hands table() a number of thousands of digits. The
    cell is cut as a text cell is, and the table's rows fit a decision."""
    from plaid_agent.core.limits import JOB_ANALYSIS_MAX_CHARS, JOB_TABLE_CELL_CHARS
    from plaid_agent.igt import job as igt_job
    from plaid_agent.igt.sandbox import table_api
    client, job = _job()
    ws = igt_job.JobWorkspace(client, runner(job).project())
    table_api(ws)('t', ['a'] * 8, [[10 ** 4000] * 8, [7, 2.5, True, None, 'x', -3, 0, 10 ** 200]])
    rows = ws.tables[0]['rows']
    assert all(len(v) <= JOB_TABLE_CELL_CHARS for v in rows[0])
    assert rows[1][:7] == [7, 2.5, True, None, 'x', -3, 0], 'a number that fits stays a number'
    assert max(len(t) for t in igt_job.table_rows_text(ws.tables[0])) <= JOB_ANALYSIS_MAX_CHARS


def test_a_proposed_change_of_values_that_json_escapes_fits_a_decision():
    """REV-JG-20: a proposed change keeps four values of 300 characters, and
    a control character costs six where it is kept. The row is cut to fit,
    and the job does not fail on it."""
    from plaid_agent.core.limits import JOB_ANALYSIS_MAX_CHARS
    from plaid_agent.igt.job import CHANGE_FORM
    client, job = _job()
    r = runner(job)
    odd = '\x01' * 300
    r.record_changes([{'kind': 'set_span', 'document_id': 'd1', 'document': 'One', 'ref': 's1', 'field': 'Gloss',
                       'from': odd, 'to': odd, 'label': odd}], note=odd)
    rows = [x for (f, _), x in client.jobs.decision_rows[job.id].items() if f.startswith(CHANGE_FORM)]
    assert len(rows) == 1 and len(rows[0]['analysis']) <= JOB_ANALYSIS_MAX_CHARS


def test_a_job_keeps_at_most_the_tables_its_report_holds_and_counts_the_rest():
    """REV-JG-15: every piece of a long job may hand the report five tables.
    The job keeps the first JOB_TABLES_MAX among its decisions and only
    counts the rest, which the report says."""
    from plaid_agent.core.limits import JOB_TABLES_MAX, JOB_TABLES_PER_PIECE
    from plaid_agent.igt import job as igt_job
    client, job = _job()
    r = runner(job)
    project = r.project()
    pieces = JOB_TABLES_MAX // JOB_TABLES_PER_PIECE + 2
    for p in range(pieces):
        tables = [{'title': f'T{p}.{t}', 'columns': ['a'], 'rows': [['x']], 'more': 0}
                  for t in range(JOB_TABLES_PER_PIECE)]
        r.record_piece(project, {'document': 'd1', 'first': f's{p}', 'whole': False}, 'note', tables)
    kept = {f[len(igt_job.TABLE_FORM):].rsplit(' ', 1)[0] for (f, _), _r in client.jobs.decision_rows[job.id].items()
            if f.startswith(igt_job.TABLE_FORM)}
    assert len(kept) == JOB_TABLES_MAX
    parts = runner(job).report_parts(job)
    assert len(parts['tables']) == JOB_TABLES_MAX
    assert parts['tables_more'] == pieces * JOB_TABLES_PER_PIECE - JOB_TABLES_MAX


# --- REV-JG2's S5s ------------------------------------------------------------------------------

def test_a_plans_list_of_documents_left_out_is_cut_to_fit_and_counted():
    """REV-JG2-6: 499 documents left out by the plan, each named with 500
    letters of four bytes. The list is cut like any other and counted in
    ``left_out_more``: the report fits."""
    from plaid_agent.core.job import fit_report
    from plaid_agent.core.limits import JOB_REPORT_BUDGET_BYTES
    name = chr(0x1E900) * 500
    docs = [{'document_id': f'{i:036d}', 'name': name, 'state': 'not-reached', 'counts': {}, 'skipped': [],
             'left': []} for i in range(500)]
    report = {'totals': {}, 'documents': docs, 'summary': 'x' * 3000, 'instructions': 'y' * 2000,
              'plan': {'pieces': 'document', 'documents': [docs[0]['document_id']],
                       'left_out': [{'document_id': d['document_id'], 'name': d['name']} for d in docs[1:]]},
              'harmonize': {}, 'entries': {}}
    fit_report(report)
    assert _bytes(report) <= JOB_REPORT_BUDGET_BYTES
    plan = report['plan']
    assert plan['left_out'] == [] and plan['left_out_more'] == 499, 'cut whole before the documents'
    assert len(report['documents']) + report['documents_more'] == 500


def test_a_report_cut_to_fit_leaves_the_rows_of_the_job_whole():
    """REV-JG2-9: the report's document entries hold copies of the rows'
    lists, so a cut to fit leaves the job's rows as they are (a finish
    refused and redone reports from them)."""
    from plaid_agent.core.job import fit_report
    client, job = _job()
    skipped = [{'sentence': f's{k}', 'sentence_id': f'x{k}', 'reason': 'failed', 'kind': 'budget'}
               for k in range(300)]
    for d in job.order:
        job.rows[d]['skipped'] = list(skipped)
    report = build_report(job, 'done', None, runner(job).document_reports(job), {'changed': [], 'left': []},
                          entries_part([], []))
    fit_report(report, budget=2000)
    assert all(len(job.rows[d]['skipped']) == 300 for d in job.order)


def test_a_piece_taken_again_counts_the_tables_it_dropped_once():
    """REV-JG2-8: a piece whose tables pass the job's cap is recorded again
    (taken again after its write was put off). Its dropped tables are
    counted once."""
    from plaid_agent.core.limits import JOB_TABLES_MAX, JOB_TABLES_PER_PIECE
    client, job = _job()
    r = runner(job)
    project = r.project()
    pieces = JOB_TABLES_MAX // JOB_TABLES_PER_PIECE + 1
    for p in range(pieces):
        tables = [{'title': f'T{p}.{t}', 'columns': ['a'], 'rows': [['x']], 'more': 0}
                  for t in range(JOB_TABLES_PER_PIECE)]
        r.record_piece(project, {'document': 'd1', 'first': f's{p}', 'whole': False}, 'note', tables)
        if p == pieces - 1:
            r.record_piece(project, {'document': 'd1', 'first': f's{p}', 'whole': False}, 'note', tables)
    assert runner(job).report_parts(job)['tables_more'] == pieces * JOB_TABLES_PER_PIECE - JOB_TABLES_MAX


def test_a_piece_taken_again_that_drops_another_number_of_tables_is_counted_once(monkeypatch):
    """REV-JG3-7: the piece's row of tables dropped is keyed by the piece,
    not by its count. Taken again, a piece that drops 2 tables where its
    first run dropped 1 is counted once, as its first run, whose note and
    tables the report keeps."""
    from plaid_agent.igt import job as igt_job
    client, job = _job()
    r = runner(job)
    monkeypatch.setattr(igt_job, 'JOB_TABLES_MAX', 0)
    project = r.project()
    piece = {'document': 'd1', 'first': None, 'whole': True}
    t = {'title': 'T', 'columns': ['a'], 'rows': [['1']], 'more': 0}
    r.record_piece(project, piece, 'first run', [t])
    r.record_piece(project, piece, 'second run', [t, t])
    assert runner(job).report_parts(job)['tables_more'] == 1
