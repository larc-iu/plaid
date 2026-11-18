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

