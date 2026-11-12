"""A Stop, wherever it arrives (SPEC 1.3, REV-J-B S2-2): once the worker has
seen it, nothing more is written to any document or lexicon, no harmonize
and no entries pass, and the job ends cancelled at once with a report of
what was done. Each point a stop can arrive at: before the first stretch,
during a stretch, between documents, during harmonize, during the entries
pass."""

from job_fixtures import JobClient, Model, call, document, recorded, reply, runner, start, use

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job

J = 'JS'


def _analyse(asked, n, kwargs):
    if n == 1:
        doc = asked.split('"')[1]
        return reply(calls=[call(1, 'set_analysis', {'document': doc, 'ref': 's1.w1', 'morphemes': [{'form': 'blank'}]})])
    return reply('Done.')


def _client(n=2):
    return JobClient({f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['blank']}]) for i in range(1, n + 1)})


def _stop(client, job):
    client.jobs.cancel(job.id)
    job.beat()


def _writes(client):
    return [c for c in client.calls if c[0].startswith(('tokens', 'spans', 'vocab_links', 'vocab_items'))]


def _ended_cancelled(client, job, finished):
    assert finished is not None and finished['state'] == 'cancelled', finished
    assert client.jobs.rows[job.id]['state'] == 'cancelled'
    return client.jobs.rows[job.id]['report']


def test_a_stop_during_the_checks_writes_nothing_and_asks_no_model(monkeypatch):
    client = _client(1)
    job = start(client)
    model = use(monkeypatch, Model(_analyse))

    class Runner(igt_job.IgtRunner):
        def check(self, j):
            out = super().check(j)
            _stop(client, j)
            return out
    finished = run_job(job, Runner(job, runner(job).cfg, count=lambda v: 1))
    _ended_cancelled(client, job, finished)
    assert not model.calls and not _writes(client)


def test_a_stop_between_documents_leaves_the_next_one_alone(monkeypatch):
    client = _client(2)
    job = start(client)
    model = use(monkeypatch, Model(_analyse))
    r = runner(job)
    real = r.document

    def document(d):
        out = real(d)
        if d == 'd1':
            _stop(client, job)
        return out
    r.document = document
    report = _ended_cancelled(client, job, run_job(job, r))
    assert all('Story 2' not in c['asked'] for c in model.calls)
    assert [d['state'] for d in report['documents']] == ['done', 'not-reached']


def _harmonize_job(monkeypatch, tasks=('gloss',)):
    w = lambda g: ('ka', [('ka', g)], J)  # noqa: E731
    client = JobClient({'d1': document('d1', 'A', [{'words': [w('go'), w('go'), w('go'), w('go'), w('come')]}]),
                        'd2': document('d2', 'B', [{'words': [w('come')]}])})
    job = start(client, list(tasks), id=J)
    for d in ('d1', 'd2'):
        job.update_row(d, state='done')
    recorded(job)
    job.status['phase'] = 'harmonizing'
    return client, job


def test_a_stop_seen_when_the_glossing_ends_runs_no_harmonize(monkeypatch):
    client, job = _harmonize_job(monkeypatch)
    job.status['phase'] = 'glossing'
    r = runner(job)
    # Pressed after the walk's last check: the beat that says the phase
    # changed is the first to hear of it.
    r.work = lambda j: client.jobs.cancel(j.id)
    report = _ended_cancelled(client, job, run_job(job, r))
    assert not _writes(client)
    assert report['harmonize']['changed'] == []


def test_a_stop_during_harmonize_writes_no_further_document_and_reports_what_was_done(monkeypatch):
    client, job = _harmonize_job(monkeypatch)
    r = runner(job)
    real = r.rewrite
    done = []

    def rewrite(project, d, *a):
        out = real(project, d, *a)
        done.append(d)
        _stop(client, job)
        return out
    r.rewrite = rewrite
    report = _ended_cancelled(client, job, run_job(job, r))
    assert done == ['d1'], 'the second document was not rewritten'
    changed = report['harmonize']['changed']
    assert [f['documents'] for c in changed for f in c['from']] == [['d1']], 'what harmonize did before the stop'


def test_a_stop_before_the_entries_pass_deletes_nothing(monkeypatch):
    from test_job_entries import _entries_job
    client, job = _entries_job(maintainer=True)
    job.status['phase'] = 'harmonizing'
    r = runner(job)
    r.harmonize = lambda j: (_stop(client, j), {'changed': [], 'left': []})[1]
    report = _ended_cancelled(client, job, run_job(job, r))
    assert not [k for k, _ in client.calls if k == 'vocab_items.delete']
    assert report['entries']['deleted'] == []
    assert {e['id'] for e in report['entries']['created']} >= {'e-linked', 'e-unlinked'}, \
        'the report still lists the entries the job made'


def test_a_stop_during_the_entries_pass_deletes_nothing(monkeypatch):
    from test_job_entries import _entries_job
    client, job = _entries_job(maintainer=True)
    job.status['phase'] = 'harmonizing'
    r = runner(job)
    real = r.nothing_hangs_on

    def hangs(*a, **kw):
        _stop(client, job)
        return real(*a, **kw)
    r.nothing_hangs_on = hangs
    report = _ended_cancelled(client, job, run_job(job, r))
    assert not [k for k, _ in client.calls if k == 'vocab_items.delete']
    assert report['entries']['deleted'] == []


def test_a_done_refused_because_a_stop_came_last_ends_the_job_cancelled(monkeypatch):
    client, job = _harmonize_job(monkeypatch)
    r = runner(job)
    real = r.entries

    def entries(j):
        out = real(j)
        client.jobs.cancel(job.id)  # the heartbeat has not said so yet
        return out
    r.entries = entries
    _ended_cancelled(client, job, run_job(job, r))


# --- the line a job ends with (REV-J-B S4) ----------------------------------------

def test_a_job_that_ends_keeps_no_progress_line(monkeypatch):
    client = _client(1)
    job = start(client)
    use(monkeypatch, Model(_analyse))
    assert run_job(job, runner(job))['state'] == 'done'
    assert client.jobs.rows[job.id]['message'] is None, 'not "Writing the report."'


def test_a_stopped_job_keeps_no_progress_line(monkeypatch):
    client = _client(2)
    job = start(client)
    use(monkeypatch, Model(_analyse))
    r = runner(job)
    real = r.document
    r.document = lambda d: (real(d), _stop(client, job))[0]
    assert run_job(job, r)['state'] == 'cancelled'
    assert client.jobs.rows[job.id]['message'] is None


def test_a_job_that_lost_its_starters_access_says_so_by_its_reason(monkeypatch):
    from plaid_client import PlaidAPIError
    client = _client(1)
    job = start(client)
    use(monkeypatch, Model(_analyse))

    def locked(document_id, **kw):
        raise PlaidAPIError('HTTP 403', status=403, response_data={'error': 'Write access required.'})
    client.documents.locked = locked
    finished = run_job(job, runner(job))
    assert finished['reason'] == 'starter-access'
    assert client.jobs.rows[job.id]['message'] is None, 'the app words it by the reason, not a progress line'
