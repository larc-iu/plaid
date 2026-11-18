"""A piece stopped because the same tool call failed three times in a row
(``REPEAT_STOP``) is a model fault, never finished work (D3 of the job
review 2026-11-18). With nothing staged it fails as any model fault does
(``repeating``): a stretch is halved and its single sentences skipped as
failed. With work staged it ends without finishing, by THE rule after such a
piece (CONTRACT, "Added by RW"): what it staged is written and each sentence
it staged nothing in is skipped as failed."""

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use


def _client(n=1):
    return JobClient({'d1': document('d1', 'Story 1', [{'words': ['blank']} for _ in range(n)])})


def _refused_thrice(first=None):
    def answer(asked, n, kwargs):
        if first is not None and n == 1:
            return reply(calls=[first])
        return reply(calls=[call(10 + n, 'propose_job', {'instructions': 'x'})])
    return answer


def test_a_piece_that_repeats_a_refused_call_with_nothing_staged_fails_and_its_sentence_is_skipped(monkeypatch):
    client = _client()
    job = start(client)
    use(monkeypatch, Model(_refused_thrice()))
    assert runner(job).document('d1') == 'done'
    row = job.rows['d1']
    assert [(s.get('reason'), s.get('kind')) for s in row.get('skipped') or []] == [('failed', 'repeating')], row


def test_a_piece_that_repeats_a_refused_call_with_work_staged_writes_it_and_skips_the_rest(monkeypatch):
    client = _client(2)
    job = start(client)
    first = call(1, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1', 'morphemes': [{'form': 'blank'}]})
    use(monkeypatch, Model(_refused_thrice(first)))
    writes = []
    from plaid_agent.igt import job as igt_job
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        writes.append([o.get('kind') for o in ops])
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    assert runner(job).document('d1') == 'done'
    assert any('set_analysis' in w for w in writes), writes
    row = job.rows['d1']
    assert [(s.get('sentence'), s.get('reason'), s.get('kind')) for s in row.get('skipped') or []] == \
        [('s2', 'failed', 'repeating')], row
