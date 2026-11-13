"""A sentence the job began to write in is never a target again unless its
write is known not to have landed (REV-FIX3-1). Before a write is sent the
job stores a writing row for each sentence it writes in. When the write's
record is lost (a crash, a passing error, a write put off) and a person then
removes everything the job wrote in a sentence, the sentence reads as never
written: it is left, listed as interrupted, and the job writes nothing more
there. Each way into that window is tested, and each way a write is known
to have sent nothing, which makes its sentences targets again."""

import json

import pytest

from job_fixtures import JobClient, Model, call, document, reply, runner, start, targets_named, use

from plaid_client import PlaidAPIError
from plaid_agent.core.job import run_job
from plaid_agent.core.plan import PlanError, PlanOutOfDate
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import RECORD_FORM, WRITING_FORM
from test_job_vouched import _iso, _person_edits

J = 'JW'
MINE = {'ka': ('ka', [('ka', 'go')], J), 'ta': ('ta', [('ta', 'go')], J), 'sa': ('sa', [('sa', 'go')], J)}
BLANK = [{'words': ['ka', 'ta']}, {'words': ['sa']}]
WRITTEN = [{'words': [MINE['ka'], MINE['ta']]}, {'words': [MINE['sa']]}]


class Crash(BaseException):
    """The worker's process dies here."""


def _gloss(asked, n, kwargs):
    """'go' on every word of each target sentence named."""
    if n > 1:
        return reply('Done.')
    words = {1: ['ka', 'ta'], 2: ['sa']}
    calls = [call(len(words) * s + i, 'set_analysis', {
        'document': 'Story', 'ref': f's{s}.w{i}', 'morphemes': [{'form': f, 'fields': {'Morph Gloss': 'go'}}]})
        for s in targets_named(asked) for i, f in enumerate(words[s], start=1)]
    return reply(calls=calls)


def _translations_named(asked):
    line = next(line for line in asked.splitlines() if line.startswith('Translate '))
    return [int(r[1:]) for r in line[len('Translate '):].split('.')[0].split(', ')]


def _job(monkeypatch, tasks=('gloss',), before=BLANK, after=WRITTEN, model=_gloss):
    client = JobClient({'d1': document('d1', 'Story', before)})
    client.after_write['d1'] = document('d1', 'Story', after, version=2)
    clock = {'t': 1_800_000_000.0}
    job = start(client, list(tasks), id=J, now=lambda: clock['t'])
    job._sleep = lambda s: clock.__setitem__('t', clock['t'] + s)
    job.job['created_at'] = _iso(clock['t'] - 3600)
    model = use(monkeypatch, Model(model))
    return client, job, clock, model


def _crash_at_record(monkeypatch, job):
    """The process dies on the record's call, after the write landed."""
    real = job.add_decisions

    def add(decisions):
        if any(d['form'].startswith(RECORD_FORM) for d in decisions):
            raise Crash()
        return real(decisions)
    monkeypatch.setattr(job, 'add_decisions', add)
    try:
        runner(job).document('d1')
    except Crash:
        pass
    monkeypatch.setattr(job, 'add_decisions', real)


def _crash_before_write(monkeypatch, job, nth=1):
    """The process dies after the writing rows, before the ``nth`` write is
    sent."""
    real = igt_job.execute_plan
    n = {'n': 0}

    def execute(c, ops, **kw):
        n['n'] += 1
        if n['n'] == nth:
            raise Crash()
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    try:
        runner(job).document('d1')
    except Crash:
        pass
    monkeypatch.setattr(igt_job, 'execute_plan', real)


def _resume(client, job):
    """A new worker process: the rows as core has them."""
    job.rows = {r['document_id']: dict(r) for r in client.jobs.get(J)['documents']}
    return runner(job)


def _staged(monkeypatch):
    seen = []
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        seen.extend(ops)
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    return seen


def _skipped(job):
    return [(s['sentence_id'], s['reason']) for s in job.rows['d1'].get('skipped') or []]


def _writing(client):
    return sorted(f[len(WRITING_FORM):] for f, _ in client.jobs.decision_rows.get(J, {}) if f.startswith(WRITING_FORM))


def _mark(client, sid):
    rows = [r for (f, _), r in client.jobs.decision_rows[J].items() if f == RECORD_FORM + sid]
    assert len(rows) == 1, rows
    return json.loads(rows[0]['analysis'])


# --- the window between a write and its record ---------------------------------------

def test_a_crash_after_the_write_and_a_person_clearing_every_analysis_of_a_sentence(monkeypatch):
    """REV-FIX3 F1: s1 reads as never written. It is left and listed, s2 is
    recorded, and nothing is asked or written again."""
    client, job, clock, model = _job(monkeypatch)
    _crash_at_record(monkeypatch, job)
    assert _writing(client) == ['d1-s1', 'd1-s2'], 'stored before the write'
    clock['t'] += 3600
    _person_edits(client, 'd1', [{'words': ['ka', 'ta']}, {'words': [MINE['sa']]}], 3, clock)
    clock['t'] += 3600
    asked = len(model.calls)
    staged = _staged(monkeypatch)
    assert _resume(client, job).document('d1') == 'done'
    assert not staged and len(model.calls) == asked, 'the cleared words are not glossed again'
    assert _skipped(job) == [('d1-s1', 'interrupted')]
    assert _mark(client, 'd1-s2')['counts']['words'] == 1
    assert job.rows['d1']['done'] == 2


def test_one_passing_error_after_the_write_and_a_person_deleting_the_translation_in_the_wait(monkeypatch):
    """REV-FIX3 L5 on the fake: the record's call meets a 502, the starter
    deletes the job's translation of s1 in the 30 s wait. s1 is left."""
    def translate(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        return reply(calls=[call(i, 'set_field', {'document': 'Story', 'refs': [f's{i}'], 'field': 'Translation',
                                                  'value': f'T{i}.'}) for i in _translations_named(asked)])
    before = [{'words': ['ka']}, {'words': ['sa']}]
    after = [{'words': ['ka'], 'translation': ('T1.', J)}, {'words': ['sa'], 'translation': ('T2.', J)}]
    client, job, clock, model = _job(monkeypatch, ('translate',), before, after, translate)
    real = client.jobs.add_decisions
    lost = {'n': 0}

    def add(job_id, worker_id, decisions):
        if any(d['form'].startswith(RECORD_FORM) for d in decisions) and not lost['n']:
            lost['n'] += 1
            raise PlaidAPIError('HTTP 502', status=502)
        return real(job_id, worker_id, decisions)
    client.jobs.add_decisions = add
    slept = job._sleep

    def sleep(s):
        if lost['n'] == 1:
            lost['n'] += 1
            _person_edits(client, 'd1', [{'words': ['ka']}, {'words': ['sa'], 'translation': ('T2.', J)}], 3,
                          {'t': clock['t'] - 700})
        slept(s)
    job._sleep = sleep
    staged = _staged(monkeypatch)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', client.jobs.rows[J]['message']
    assert [o['token_id'] for o in staged] == ['d1-s1', 'd1-s2'], 'each translated once'
    assert len([c for c in model.calls if c['n'] == 1]) == 1, 'nothing asked again'
    report = client.jobs.rows[J]['report']
    assert report['totals']['translations'] == 1 and report['totals']['skipped_interrupted'] == 1
    assert [(s['sentence'], s['reason']) for s in report['documents'][0]['skipped']] == [('s1', 'interrupted')]


def test_a_crash_after_the_write_with_nobody_writing_since_is_recorded_whole(monkeypatch):
    client, job, clock, model = _job(monkeypatch)
    _crash_at_record(monkeypatch, job)
    staged = _staged(monkeypatch)
    assert _resume(client, job).document('d1') == 'done'
    assert not staged and not _skipped(job)
    assert job.rows['d1']['counts']['words'] == 3 and job.rows['d1']['done'] == 2
    assert len(_mark(client, 'd1-s1')['words']) == 2, 'vouched for: the newest change is the job\'s own glossing'


# --- a write that never left: its writing row and nothing else ------------------------

def test_a_crash_between_the_writing_row_and_the_write_with_nobody_writing_takes_the_sentences_again(monkeypatch):
    """The document's newest change is older than the job: nothing of the
    job ever landed, so its sentences are targets again, written once."""
    client, job, clock, model = _job(monkeypatch)
    _crash_before_write(monkeypatch, job)
    assert _writing(client) == ['d1-s1', 'd1-s2'] and not client.batches
    staged = _staged(monkeypatch)
    assert _resume(client, job).document('d1') == 'done'
    assert sorted(o['word_id'] for o in staged) == ['d1-s1w1', 'd1-s1w2', 'd1-s2w1']
    assert not _skipped(job) and job.rows['d1']['counts']['words'] == 3


def test_a_crash_before_a_later_stretchs_write_after_the_jobs_own_glossing_takes_it_again(monkeypatch):
    """The newest change is the job's glossing of the stretch before:
    nobody wrote since, so s2's write never landed."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)
    client, job, clock, model = _job(monkeypatch, after=[{'words': [MINE['ka'], MINE['ta']]}, {'words': ['sa']}])
    _crash_before_write(monkeypatch, job, nth=2)
    assert not _skipped(job) and 'd1-s2' in _writing(client)
    real, staged = igt_job.execute_plan, []

    def execute(c, ops, **kw):
        staged.extend(ops)
        client.after_write['d1'] = document('d1', 'Story', WRITTEN, version=3)
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    assert _resume(client, job).document('d1') == 'done'
    assert [o['word_id'] for o in staged] == ['d1-s2w1']
    assert not _skipped(job) and job.rows['d1']['counts']['words'] == 3


def test_a_crash_between_the_writing_row_and_the_write_then_a_person_writing_leaves_the_sentences(monkeypatch):
    """The safe side: the job cannot tell a write that never left from one
    whose work a person removed, so it writes nothing more there and lists
    each sentence as interrupted."""
    client, job, clock, model = _job(monkeypatch)
    _crash_before_write(monkeypatch, job)
    clock['t'] += 3600
    _person_edits(client, 'd1', BLANK, 3, clock)
    clock['t'] += 3600
    staged = _staged(monkeypatch)
    assert _resume(client, job).document('d1') == 'done'
    assert not staged
    assert _skipped(job) == [('d1-s1', 'interrupted'), ('d1-s2', 'interrupted')]
    assert job.rows['d1']['done'] == 2


# --- known to have sent nothing: targets again in the same worker ----------------------

def _moved(c, ops):
    try:
        raise PlaidAPIError('HTTP 409 version', status=409)
    except PlaidAPIError as e:
        raise PlanError('moved', 0, len(ops)) from e


def _gone(c, ops):
    raise PlanOutOfDate(['An entry is gone.'])


@pytest.mark.parametrize('refusal', [_moved, _gone], ids=['moved-twice', 'out-of-date'])
def test_a_write_put_off_having_sent_nothing_is_taken_again_after_a_person_wrote(monkeypatch, refusal):
    """Refused for the moved version on both tries, or found out of date
    before anything was sent: put off. A person wrote meanwhile, and the
    sentences are still targets when the document comes back."""
    client, job, clock, model = _job(monkeypatch)
    real = igt_job.execute_plan
    left = {'n': 2 if refusal is _moved else 1}

    def execute(c, ops, **kw):
        if left['n']:
            left['n'] -= 1
            refusal(c, ops)
        client.after_write['d1'] = document('d1', 'Story', WRITTEN, version=4)
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    r = runner(job)
    assert r.document('d1') == 'deferred' and not client.batches
    _person_edits(client, 'd1', BLANK, 3, {'t': clock['t'] - 700})
    assert r.document('d1') == 'done'
    assert not _skipped(job) and job.rows['d1']['counts']['words'] == 3


def test_a_writing_row_whose_answer_is_lost_sends_nothing_and_the_walk_takes_the_sentences_again(monkeypatch):
    client, job, clock, model = _job(monkeypatch)
    real = client.jobs.add_decisions
    lost = {'n': 1}

    def add(job_id, worker_id, decisions):
        real(job_id, worker_id, decisions)
        if lost['n'] and any(d['form'].startswith(WRITING_FORM) for d in decisions):
            lost['n'] -= 1
            raise PlaidAPIError('HTTP 502', status=502)
    client.jobs.add_decisions = add
    staged = _staged(monkeypatch)
    assert runner(job).document('d1') == 'done'
    assert sorted(o['word_id'] for o in staged) == ['d1-s1w1', 'd1-s1w2', 'd1-s2w1'], 'written once'
    assert not _skipped(job) and job.rows['d1']['counts']['words'] == 3


def test_a_stretch_halved_stores_a_writing_row_only_for_what_it_writes(monkeypatch):
    def fails_on_s2(asked, n, kwargs):
        if 2 in targets_named(asked):
            return reply('...', finish='length')
        return _gloss(asked, n, kwargs)
    client, job, clock, model = _job(monkeypatch, after=[{'words': [MINE['ka'], MINE['ta']]}, {'words': ['sa']}],
                                     model=fails_on_s2)
    assert runner(job).document('d1') == 'done'
    assert _writing(client) == ['d1-s1']
    assert _skipped(job) == [('d1-s2', 'failed')]
