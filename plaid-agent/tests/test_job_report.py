"""The report a job stores at its finish (SPEC 9, CONTRACT 5.3): lists, never
a map keyed by an id, each cut at 500 with a count of the rest."""

from job_fixtures import JobClient, Model, document, reply, runner, start, use

from plaid_agent.core.job import build_report, run_job
from plaid_agent.core.limits import JOB_REPORT_LIST_MAX
from plaid_agent.igt.job import entries_part

KEYS = {'state', 'reason', 'tasks', 'note', 'started_by', 'model', 'started_at', 'finished_at',
        'paused_for_people_s', 'paused_for_model_s', 'stopped', 'totals', 'documents', 'harmonize', 'entries'}


def _job():
    client = JobClient({'d1': document('d1', 'One', [{'words': ['a']}]),
                        'd2': document('d2', 'Two', [{'words': ['b']}])})
    return client, start(client, ['gloss', 'link'], note='Gloss loans whole.')


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
                           'changed': 1, 'protected': 0, 'analyzed': 2},
                   skipped=[{'sentence': 's4', 'sentence_id': 'x', 'reason': 'too-long', 'kind': None}])
    job.update_row('d2', state='in-use')
    created = [{'id': f'e{i}', 'lexicon': 'v1' if i < JOB_REPORT_LIST_MAX else 'v2', 'form': f'f{i}', 'gloss': 'g'}
               for i in range(JOB_REPORT_LIST_MAX + 3)]
    report = build_report(job, 'done', None, runner(job).document_reports(job),
                          {'changed': [{'form': 'ka', 'to': 'ka ‘go’', 'by': 'majority', 'from': []}], 'left': []},
                          entries_part(created, [], []))
    assert set(report) == KEYS
    assert report['note'] == 'Gloss loans whole.' and report['tasks'] == ['gloss', 'link']
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
    p = __import__('job_fixtures').job_project()
    del p['vocabs'][0]['config']['igt']['fields']['status']
    client = JobClient({'d1': document('d1', 'One', [{'words': ['a']}])}, project=p)
    job = start(client, ['gloss', 'link'])
    finished = run_job(job, runner(job))
    assert finished['state'] == 'failed' and finished['reason'] == 'no-status-field'
    assert client.jobs.rows[job.id]['message'] == 'The lexicon "Lexicon" has no Status field.'
