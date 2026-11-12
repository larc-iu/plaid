"""A stretch that cannot finish is halved, and one sentence that cannot is
skipped (SPEC 3.6). Nothing a failed stretch staged is written. The
decide-now line comes at the 15th call and at 48,000 prompt tokens, and the
calls after it are offered the plan tools alone."""

import pytest

from job_fixtures import JobClient, Model, blank, call, document, reply, runner, start, targets_named, use

from plaid_agent.core import job as core_job
from plaid_agent.core.limits import JOB_CALL_DECIDE_AT_TOKENS, JOB_STRETCH_MAX_ROUNDS
from plaid_agent.core.prompt import JOB_DECIDE_NOW


def _job(n=5, tasks=('gloss',)):
    client = JobClient({'d1': document('d1', 'Story', blank(n))})
    return client, start(client, tasks)


def analyse(asked, i=1):
    """The calls staging every target sentence the message names."""
    return [call(i + k, 'set_analysis', {'document': 'Story', 'analyses': [
        {'ref': f's{n}.w1', 'morphemes': [{'form': f'ka{n}', 'type': 'stem', 'fields': {'Morph Gloss': 'go'}}]}]})
            for k, n in enumerate(targets_named(asked))]


def looping(asked, n, kwargs):
    """A model that reads for ever, staging first."""
    if n == 1:
        return reply(calls=analyse(asked))
    return reply(calls=[call(100 + n, 'analyses_of', {'form': f'x{n}'})])


def test_a_stretch_over_the_round_cap_is_halved_into_three_and_two(monkeypatch):
    client, job = _job()
    seen = []

    def answer(asked, n, kwargs):
        if n == 1:
            seen.append(targets_named(asked))
        if len(targets_named(asked)) > 3:
            return looping(asked, n, kwargs)
        return reply(calls=analyse(asked)) if n == 1 else reply('Done.')
    model = use(monkeypatch, Model(answer))
    assert runner(job).document('d1') == 'done'
    assert seen == [[1, 2, 3, 4, 5], [1, 2, 3], [4, 5]]
    assert max(c['n'] for c in model.calls if len(targets_named(c['asked'])) == 5) == JOB_STRETCH_MAX_ROUNDS
    row = job.rows['d1']
    assert row['done'] == 5 and row['last_sentence'] == 'd1-s5' and not row.get('skipped')


def test_a_half_that_fails_again_is_halved_and_one_sentence_is_skipped_with_its_kind(monkeypatch):
    client, job = _job()
    seen = []

    def answer(asked, n, kwargs):
        if n == 1:
            seen.append(targets_named(asked))
        if 2 in targets_named(asked):
            return looping(asked, n, kwargs)
        return reply(calls=analyse(asked)) if n == 1 else reply('Done.')
    use(monkeypatch, Model(answer))
    runner(job).document('d1')
    assert seen == [[1, 2, 3, 4, 5], [1, 2, 3], [1, 2], [1], [2], [3], [4, 5]]
    row = job.rows['d1']
    assert row['skipped'] == [{'sentence': 's2', 'sentence_id': 'd1-s2', 'reason': 'failed', 'kind': 'budget'}]
    assert row['done'] == 5 and row['last_sentence'] == 'd1-s5'


def test_nothing_a_failed_stretch_staged_is_written(monkeypatch):
    client, job = _job()

    def answer(asked, n, kwargs):
        if 2 in targets_named(asked):
            return looping(asked, n, kwargs)
        return reply(calls=analyse(asked)) if n == 1 else reply('Done.')
    use(monkeypatch, Model(answer))
    runner(job).document('d1')
    created = str([p for k, p in client.calls if k in ('tokens.create', 'tokens.bulk_create')])
    assert "'ka2'" not in created, 'the stretches holding s2 failed, so s2 was never written'
    for n in (1, 3, 4, 5):
        assert f"'ka{n}'" in created


@pytest.mark.parametrize('kind,raise_it', [
    ('output', lambda: core_job.TurnFailed('The model wrote 32,768 tokens without finishing.')),
    ('repeating', lambda: core_job.TurnFailed(core_job.REPEATING_LINE)),
])
def test_a_one_sentence_stretch_is_skipped_with_the_kind_of_its_failure(monkeypatch, kind, raise_it):
    client, job = _job(1)

    def answer(asked, n, kwargs):
        raise raise_it()
    use(monkeypatch, Model(answer))
    runner(job).document('d1')
    assert job.rows['d1']['skipped'] == [{'sentence': 's1', 'sentence_id': 'd1-s1', 'reason': 'failed',
                                          'kind': kind}]


def test_the_decide_now_line_comes_at_the_fifteenth_call_with_the_plan_tools_alone(monkeypatch):
    client, job = _job(1)

    def answer(asked, n, kwargs):
        if any(m.get('content') == JOB_DECIDE_NOW for m in kwargs['messages']):
            return reply(calls=analyse(asked)) if not any(m['role'] == 'tool' and 'Staged' in str(m['content'])
                                                          for m in kwargs['messages'][-2:]) else reply('Done.')
        return reply(calls=[call(100 + n, 'analyses_of', {'form': f'x{n}'})])
    model = use(monkeypatch, Model(answer))
    runner(job).document('d1')
    told = [c for c in model.calls if any(m.get('content') == JOB_DECIDE_NOW for m in c['kwargs']['messages'])]
    assert told[0]['n'] == 15
    assert [m.get('content') for m in told[0]['kwargs']['messages']].count(JOB_DECIDE_NOW) == 1
    assert {t['function']['name'] for t in told[0]['kwargs']['tools']} == {'set_field', 'set_analysis'}
    assert {t['function']['name'] for t in model.calls[0]['kwargs']['tools']} >= {'analyses_of', 'set_analysis'}
    assert not job.rows['d1'].get('skipped'), 'it decided in time'


def test_the_decide_now_line_comes_once_a_prompt_reaches_48000_tokens(monkeypatch):
    client, job = _job(1)
    r = runner(job)
    big = {'n': 0}

    def count(value):
        return JOB_CALL_DECIDE_AT_TOKENS if big['n'] >= 2 and isinstance(value, list) and value \
            and isinstance(value[0], dict) and value[0].get('role') == 'system' else 10
    r.count = count

    def answer(asked, n, kwargs):
        big['n'] = n
        if any(m.get('content') == JOB_DECIDE_NOW for m in kwargs['messages']):
            return reply(calls=analyse(asked)) if n < 5 else reply('Done.')
        return reply(calls=[call(100 + n, 'analyses_of', {'form': f'x{n}'})])
    model = use(monkeypatch, Model(answer))
    r.document('d1')
    told = [c['n'] for c in model.calls if any(m.get('content') == JOB_DECIDE_NOW for m in c['kwargs']['messages'])]
    assert told and told[0] == 3


def test_a_prompt_over_the_cap_fails_the_stretch_before_it_is_sent(monkeypatch):
    client, job = _job(1)
    r = runner(job)
    r.count = lambda value: 70000
    model = use(monkeypatch, Model(lambda asked, n, kwargs: reply('Done.')))
    r.document('d1')
    assert not model.calls, 'never sent'
    assert job.rows['d1']['skipped'][0]['kind'] == 'budget'


def test_halve_runs_halves_in_order():
    tried, skipped = [], []

    def attempt(part):
        tried.append(list(part))
        if len(part) > 1 or part == ['c']:
            raise core_job.StretchFailed('context')
    core_job.halve(list('abcde'), attempt, lambda s, k: skipped.append((s, k)))
    assert tried == [list('abcde'), list('abc'), list('ab'), ['a'], ['b'], ['c'], list('de'), ['d'], ['e']]
    assert skipped == [('c', 'context')]
