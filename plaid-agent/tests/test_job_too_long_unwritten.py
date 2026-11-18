"""STRESS S8-1 and S8-2: a sentence the checks skip as too long for a job
(over JOB_SENTENCE_MAX_WORDS words) is never shown to a whole-document
piece and nothing is written in it: a change staged there is refused. It
counts as skipped only in a document the job worked."""

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_agent.core.job import run_job
from plaid_agent.core.limits import JOB_SENTENCE_MAX_WORDS

LONG = {'words': [f'zz{i}' for i in range(1, JOB_SENTENCE_MAX_WORDS + 12)]}


def _analysis(ref, form):
    return call(hash(ref) % 1000, 'set_analysis', {'document': 'Story', 'ref': ref, 'morphemes': [{'form': form}]})


def test_a_whole_document_piece_is_not_shown_a_too_long_sentence_and_writes_nothing_in_it(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka']}, LONG, {'words': ['ta']}])})
    job = start(client, plan='document')
    asked_of = []

    def answer(asked, n, kwargs):
        asked_of.append(asked)
        if n == 1:
            return reply(calls=[_analysis('s1.w1', 'ka'), _analysis('s2.w3', 'zz3'), _analysis('s3.w1', 'ta')])
        return reply('Done.')
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert asked_of and 'zz3' not in asked_of[0], asked_of[0][:2000]
    (d1,) = finished['report']['documents']
    assert [s['reason'] for s in d1['skipped']] == ['too-long'], d1['skipped']
    # Written in s1 and s3 only: the change in s2 was refused.
    made = [b for b in client.payloads('tokens.create')]
    begins = sorted(m['args'][2] for m in made)
    body = client.documents.get('d1', include_body=True)['text_layers'][0]['text']['body']
    assert [body[b:b + 2] for b in begins] == ['ka', 'ta'], begins
    assert d1['counts']['analyzed'] == 2, d1['counts']


def _report_of(client, job):
    return client.jobs.rows[job.id]['report']


def test_a_too_long_sentence_of_a_document_the_job_never_reached_is_not_skipped(monkeypatch):
    """S8-2 B: a job stopped before Story 2, whose s2 is too long. Story 2 is
    not reached: nothing is skipped there, and its blanks count as not
    reached, never as in skipped sentences."""
    client = JobClient({'d1': document('d1', 'Story 1', [{'words': ['ka']}]),
                        'd2': document('d2', 'Story 2', [{'words': ['ta']}, LONG])})
    job = start(client)

    def answer(asked, n, kwargs):
        if n == 1:
            return reply(calls=[call(1, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1',
                                                         'morphemes': [{'form': 'ka'}]})])
        return reply('Done.')
    use(monkeypatch, Model(answer))
    r = runner(job)
    real = r.document

    def document_then_stop(d):
        out = real(d)
        if d == 'd1':
            client.jobs.cancel(job.id)
            job.beat()
        return out
    r.document = document_then_stop
    run_job(job, r)
    report = _report_of(client, job)
    d2 = report['documents'][1]
    assert d2['state'] == 'not-reached' and d2['skipped'] == [], d2
    assert report['totals']['skipped_too_long'] == 0, report['totals']
    assert all(not b.get('skipped') for b in d2['counts'].get('blank') or []), d2['counts']
    assert any(b.get('not_reached') for b in d2['counts'].get('blank') or []), d2['counts']


def test_a_too_long_sentence_of_a_document_a_search_matched_nothing_in_is_not_skipped(monkeypatch):
    """S8-2 A: a rename limited by a search for "walk". Story 2 holds no
    "walk" and a sentence too long for a job: it ends with nothing found,
    and nothing is skipped there."""
    from job_fixtures import planned
    g = lambda v: ('tavu', [('tavu', v)], 'human')  # noqa: E731
    client = JobClient({'d1': document('d1', 'Story 1', [{'words': [g('walk')]}]),
                        'd2': document('d2', 'Story 2', [{'words': [g('run')]}, LONG])})
    job = start(client, 'Rename the gloss walk to go.', plan=None)

    def renaming(asked, n, kwargs):
        if n == 1:
            return reply(calls=[call(1, 'set_field', {'document': 'Story 1', 'refs': ['s1.w1.m1'],
                                                      'field': 'Morph Gloss', 'value': 'go'})])
        return reply('Renamed.')
    use(monkeypatch, Model(planned(renaming, {'pieces': 'sentences', 'fills': ['Morph Gloss'],
                                              'search': {'pattern': 'walk', 'where': 'Morph Gloss'}})))
    finished = run_job(job, runner(job))
    d2 = finished['report']['documents'][1]
    assert d2['state'] == 'done' and (d2['counts'] or {}).get('matched') == 0, d2
    assert d2['skipped'] == [], d2
    assert finished['report']['totals']['skipped_too_long'] == 0
