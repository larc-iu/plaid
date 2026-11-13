"""The report's totals, each by its definition (SPEC 9, CONTRACT 5.3,
REV-J-B2 S3-5): "sentences" counts the sentences the job wrote in (an
analysis or a translation), never one it skipped or failed, nor one it only
finished with nothing written. Checked on a job whose every call fails, one
where half of them fail, and one stopped midway."""

from job_fixtures import JobClient, Model, call, document, reply, runner, start, targets_named, use

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job

J = 'JT'


def _analysing(bad=()):
    """A model that stages every target sentence named, unless one of them
    is among ``bad``: then the call reaches its output cap."""
    def answer(asked, n, kwargs):
        named = targets_named(asked)
        if set(named) & set(bad):
            return reply('...', finish='length')
        if n > 1:
            return reply('Done.')
        doc = asked.split('"')[1]
        return reply(calls=[call(k, 'set_analysis', {'document': doc, 'ref': f's{s}.w1', 'morphemes': [
            {'form': 'ka', 'type': 'stem', 'fields': {'Morph Gloss': 'go'}}]}) for k, s in enumerate(named, 1)])
    return answer


def _totals(client):
    return client.jobs.rows[J]['report']['totals']


def _nonzero(totals):
    return {k: v for k, v in totals.items() if v}


def test_a_job_whose_every_call_fails_analysed_no_sentence(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka']}, {'words': ['ka']}])})
    job = start(client, id=J)
    use(monkeypatch, Model(_analysing(bad=(1, 2))))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert _nonzero(_totals(client)) == {'documents_done': 1, 'skipped_failed': 2}


def test_a_job_where_half_the_sentences_fail_counts_the_other_half(monkeypatch):
    mine = ('ka', [('ka', 'go')], J)
    client = JobClient({d: document(d, d, [{'words': ['ka']}, {'words': ['ka']}]) for d in ('d1', 'd2')})
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        # The document once the job wrote its s1, from that write on.
        d = next(o['word_id'] for o in ops if o.get('word_id')).split('-')[0]
        client.after_write[d] = document(d, d, [{'words': [mine]}, {'words': ['ka']}], version=2)
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    job = start(client, id=J)
    use(monkeypatch, Model(_analysing(bad=(2,))))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert _nonzero(_totals(client)) == {'documents_done': 2, 'sentences': 2, 'words': 2, 'skipped_failed': 2}


def test_a_job_that_left_a_sentence_blank_did_not_analyse_it(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka']}])})
    job = start(client, id=J)
    use(monkeypatch, Model(lambda asked, n, kwargs: reply('Done.')))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert _nonzero(_totals(client)) == {'documents_done': 1}
    assert client.jobs.rows[J]['report']['documents'][0]['done'] == 1, 'the sentence was finished'


def test_a_job_stopped_midway_counts_what_it_wrote_before(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story 1', [{'words': ['ka']}]),
                        'd2': document('d2', 'Story 2', [{'words': ['ka']}])})
    client.after_write['d1'] = document('d1', 'Story 1', [{'words': [('ka', [('ka', 'go')], J)]}], version=2)
    job = start(client, id=J)
    answer = _analysing()

    def stopping(asked, n, kwargs):
        if 'Story 2' in asked:
            client.jobs.cancel(J)
            job.beat()
        return answer(asked, n, kwargs)
    use(monkeypatch, Model(stopping))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'cancelled'
    assert _nonzero(_totals(client)) == {'documents_done': 1, 'documents_not_reached': 1, 'sentences': 1,
                                         'words': 1}
