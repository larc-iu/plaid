"""A sentence the job began to write in is never a target again unless its
write is known not to have landed (REV-FIX3-1). Before a write is sent the
job stores a writing row for each sentence it writes in. When the write's
record is lost (a crash, a passing error, a write put off) and a person then
removes everything the job wrote in a sentence, the sentence reads as never
written: it is left, listed as interrupted, and the job writes nothing more
there. Each way into that window is tested, and each way a write is known
to have sent nothing, which makes its sentences targets again."""

import contextlib
import json
import re

import pytest

from job_fixtures import (INSTRUCTIONS, JobClient, Model, call, document, empty_translations, reply, runner, start,
                          targets_named, use)

from plaid_client import PlaidAPIError
from plaid_agent.core.job import run_job
from plaid_agent.core.plan import PlanError, PlanOutOfDate
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import RECORD_FORM, WRITING_FORM
from test_job_vouched import _iso, _person_edits

J = 'JW'
MINE = {'ka': ('ka', [('ka', 'go')], J), 'ta': ('ta', [('ta', 'go')], J), 'sa': ('sa', [('sa', 'go')], J)}
# People translated both sentences: a job asked to gloss has nothing else
# empty here.
BLANK = [{'words': ['ka', 'ta'], 'translation': ('One.', 'human')}, {'words': ['sa'], 'translation': ('Two.', 'human')}]
WRITTEN = [{'words': [MINE['ka'], MINE['ta']], 'translation': ('One.', 'human')},
           {'words': [MINE['sa']], 'translation': ('Two.', 'human')}]


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
    return empty_translations(asked)


def _job(monkeypatch, instructions=INSTRUCTIONS, before=BLANK, after=WRITTEN, model=_gloss):
    client = JobClient({'d1': document('d1', 'Story', before)})
    client.after_write['d1'] = document('d1', 'Story', after, version=2)
    clock = {'t': 1_800_000_000.0}
    job = start(client, instructions, id=J, now=lambda: clock['t'])
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
    client, job, clock, model = _job(monkeypatch, 'Translate the empty translations.', before, after, translate)
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


def test_a_person_clearing_one_of_the_jobs_words_is_not_listed_as_left_blank(monkeypatch):
    """REV-FIX3-3: the record of an interrupted write lists as left only the
    targets the job was not writing. A word it wrote that reads blank now
    was cleared by a person (or its batch never landed): not "Left blank"."""
    def first_two(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        return reply(calls=[call(i, 'set_analysis', {'document': 'Story', 'ref': f's1.w{i}', 'morphemes': [
            {'form': f, 'fields': {'Morph Gloss': 'go'}}]}) for i, f in ((1, 'ka'), (2, 'ta'))])
    before = [{'words': ['ka', 'ta', 'pa']}]
    after = [{'words': [MINE['ka'], MINE['ta'], 'pa']}]
    client, job, clock, model = _job(monkeypatch, before=before, after=after, model=first_two)
    _crash_at_record(monkeypatch, job)
    clock['t'] += 3600
    _person_edits(client, 'd1', [{'words': [MINE['ka'], 'ta', 'pa']}], 3, clock)
    clock['t'] += 3600
    assert _resume(client, job).document('d1') == 'done'
    mark = _mark(client, 'd1-s1')
    # The record holds every blank it passed, the empty translation too: the
    # report lists only what the job filled somewhere (``document_reports``).
    assert [x['ref'] for x in mark['left'] if x['form']] == ['s1.w3'], 'only the word the model left'
    assert mark['counts']['words'] == 1 and mark['counts']['left'] == 1


def test_a_write_the_starter_confirmed_after_a_crash_is_recorded_and_counted(monkeypatch):
    """REV-B4-5: the write landed, the record was lost to a crash, and the
    starter then approved the job's proposals in s1. Something of the job's
    is there, confirmed: the write landed, so s1 is recorded with its words
    counted, never listed "Write interrupted"."""
    client, job, clock, model = _job(monkeypatch)
    _crash_at_record(monkeypatch, job)
    clock['t'] += 3600
    ok = {f: (f, [(f, 'go')], 'confirmed:' + J) for f in ('ka', 'ta')}
    _person_edits(client, 'd1', [{'words': [ok['ka'], ok['ta']]}, {'words': [MINE['sa']]}], 3, clock)
    clock['t'] += 3600
    staged = _staged(monkeypatch)
    assert _resume(client, job).document('d1') == 'done'
    assert not staged and not _skipped(job)
    assert job.rows['d1']['counts']['words'] == 3 and job.rows['d1']['counts']['analyzed'] == 2
    assert _mark(client, 'd1-s1')['words'] == {}, 'a confirmed word is no longer the job\'s to harmonize'


def test_a_translation_the_starter_confirmed_after_a_crash_is_recorded_and_counted(monkeypatch):
    def translate(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        return reply(calls=[call(1, 'set_field', {'document': 'Story', 'refs': ['s1'], 'field': 'Translation',
                                                  'value': 'T1.'})])
    client, job, clock, model = _job(monkeypatch, 'Translate the empty translations.', [{'words': ['ka']}],
                                     [{'words': ['ka'], 'translation': ('T1.', J)}], translate)
    _crash_at_record(monkeypatch, job)
    clock['t'] += 3600
    _person_edits(client, 'd1', [{'words': ['ka'], 'translation': ('T1.', 'confirmed:' + J)}], 3, clock)
    clock['t'] += 3600
    staged = _staged(monkeypatch)
    assert _resume(client, job).document('d1') == 'done'
    assert not staged and not _skipped(job)
    assert job.rows['d1']['counts']['translations'] == 1


def test_another_machines_translation_is_replaced_and_counted(monkeypatch):
    """Ruling 17: a translation another machine wrote is the job's to
    replace when its instructions say so. It is written as the job's
    proposal, counted as a translation replaced, and nothing is proposed."""
    def translate(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        return reply(calls=[call(1, 'set_field', {'document': 'Story', 'refs': ['s1'], 'field': 'Translation',
                                                  'value': 'New.'})])
    before = [{'words': ['ka'], 'translation': ('Old.', 'machine')}]
    after = [{'words': ['ka'], 'translation': ('New.', J)}]
    client, job, clock, model = _job(monkeypatch, 'Translate every sentence again.', before, after, translate)
    staged = _staged(monkeypatch)
    assert runner(job).document('d1') == 'done'
    assert [o['kind'] for o in staged] == ['set_span'], staged
    counts = job.rows['d1']['counts']
    assert not counts.get('proposed') and counts.get('refreshed') == 1 and counts.get('changes') == 1
    assert not [f for (f, _k) in client.jobs.decision_rows[J] if f.startswith(' change ')]


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


def test_a_unit_begun_before_the_job_and_ended_after_it_is_someone_writing_since(monkeypatch):
    """REV-B4-4: a crash between the writing row and the write, then a
    person writes in a group they began before the job was made (core gives
    the unit its first member's ``time`` and its last's ``end_time``). The
    document is not quiet: the safe side, the sentences are left."""
    client, job, clock, model = _job(monkeypatch)
    _crash_before_write(monkeypatch, job)
    created = clock['t'] - 3600
    client._holder('d1')['audit'].append({'id': 'person-0', 'time': _iso(created - 100),
                                          'end_time': _iso(clock['t'] - 700), 'ref': None,
                                          'documents': [{'id': 'd1'}], 'ops': []})
    staged = _staged(monkeypatch)
    assert _resume(client, job).document('d1') == 'done'
    assert not staged
    assert _skipped(job) == [('d1-s1', 'interrupted'), ('d1-s2', 'interrupted')]


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


def test_a_word_a_try_that_sent_nothing_was_for_is_left_blank_when_the_next_try_leaves_it(monkeypatch):
    """REV-B4-7: the first try was for ka, ta and sa and sent nothing (the
    version moved on both tries). Taken again, the model now leaves ta. The
    record of s1 is then lost to a passing error and s1 is recorded from the
    document (``settle``): ta is "Left blank", since no write that was sent
    was for it."""
    asked = {'n': 0}

    def model(text, n, kwargs):
        if n == 1:
            asked['n'] += 1
        if n > 1:
            return reply('Done.')
        words = {1: ['ka', 'ta'], 2: ['sa']} if asked['n'] == 1 else {1: ['ka'], 2: ['sa']}
        return reply(calls=[call(10 * s + i, 'set_analysis', {'document': 'Story', 'ref': f's{s}.w{i}', 'morphemes': [
            {'form': f, 'fields': {'Morph Gloss': 'go'}}]}) for s in targets_named(text)
            for i, f in enumerate(words[s], start=1)])
    client, job, clock, _ = _job(monkeypatch, after=[{'words': [MINE['ka'], 'ta']}, {'words': [MINE['sa']]}],
                                 model=model)
    real = igt_job.execute_plan
    left = {'n': 2}

    def execute(c, ops, **kw):
        if left['n']:
            left['n'] -= 1
            _moved(c, ops)
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    real_add = client.jobs.add_decisions
    lost = {'n': 1}

    def add(job_id, worker_id, decisions):
        if lost['n'] and any(d['form'].startswith(RECORD_FORM) for d in decisions):
            lost['n'] -= 1
            raise PlaidAPIError('HTTP 502', status=502)
        return real_add(job_id, worker_id, decisions)
    client.jobs.add_decisions = add
    r = runner(job)
    assert r.document('d1') == 'deferred'
    assert r.document('d1') == 'done'
    assert asked['n'] == 2
    mark = _mark(client, 'd1-s1')
    assert [x['ref'] for x in mark['left'] if x['form']] == ['s1.w2'], mark
    assert mark['counts']['left'] == 1 and mark['counts']['words'] == 1


# --- a passing error inside the write: before it or after it -------------------------------

def test_a_read_refused_before_the_write_sends_nothing_and_the_walk_takes_the_sentences_again(monkeypatch):
    """REV-B4-6: the plan's reads come before its first write (offsets
    rebased, scopes resolved, entries checked). One 502 there, in a document
    the starter wrote in twelve minutes ago: nothing was sent, so the
    stretch's sentences are targets again, never "Write interrupted"."""
    from plaid_agent.core import fingerprint
    client, job, clock, model = _job(monkeypatch)
    _person_edits(client, 'd1', BLANK, 3, {'t': clock['t'] - 700})
    client.after_write['d1'] = document('d1', 'Story', WRITTEN, version=4)
    real = fingerprint.rebase_offsets
    once = {'n': 1}

    def rebase(c, kind, ops):
        if once['n']:
            once['n'] -= 1
            raise PlaidAPIError('HTTP 502', status=502, method='GET')
        return real(c, kind, ops)
    monkeypatch.setattr(fingerprint, 'rebase_offsets', rebase)
    staged = _staged(monkeypatch)
    assert runner(job).document('d1') == 'done'
    assert not _skipped(job)
    assert sorted(o['word_id'] for o in staged) == ['d1-s1w1', 'd1-s1w1', 'd1-s1w2', 'd1-s1w2', 'd1-s2w1',
                                                     'd1-s2w1'], 'asked again once, the first ask refused'
    assert job.rows['d1']['counts']['words'] == 3


def test_an_error_after_the_write_landed_is_still_taken_as_a_write_that_may_have_landed(monkeypatch):
    """The other side of REV-B4-6, which must stay: the write lands and the
    operation's end then meets a 502 (``end_operation``, after the last
    batch). In the wait the starter clears the job's work in s1. s1 is not
    written again: it is listed "Write interrupted"."""
    client, job, clock, model = _job(monkeypatch)
    real_op = client.operation
    once = {'n': 1}

    @contextlib.contextmanager
    def operation(*args, **kwargs):
        with real_op(*args, **kwargs) as op:
            yield op
        if once['n'] and kwargs.get('kind') == 'job':
            once['n'] -= 1
            raise PlaidAPIError('HTTP 502', status=502)
    monkeypatch.setattr(client, 'operation', operation)
    slept = job._sleep

    def sleep(s):
        if not once['n']:
            once['n'] = -1
            _person_edits(client, 'd1', [{'words': ['ka', 'ta']}, {'words': [MINE['sa']]}], 3,
                          {'t': clock['t'] - 700})
        slept(s)
    job._sleep = sleep
    staged = _staged(monkeypatch)
    assert runner(job).document('d1') == 'done'
    assert sorted(o['word_id'] for o in staged) == ['d1-s1w1', 'd1-s1w2', 'd1-s2w1'], 'written once'
    assert _skipped(job) == [('d1-s1', 'interrupted')]
    assert _mark(client, 'd1-s2')['counts']['words'] == 1


# --- what the starter clears under the lock, right after the write -------------------------

def test_a_word_the_starter_clears_under_the_lock_is_not_listed_left_blank(monkeypatch):
    """REV-B4-2: the write lands whole and the starter clears the job's
    proposal on pa before the job reads the document again. pa was not left
    blank by the model: it is not "Left blank" (as ``settle`` already
    lists, REV-FIX3-3)."""
    client, job, clock, model = _job(monkeypatch, before=[{'words': ['ka', 'ta']}],
                                     after=[{'words': [MINE['ka'], MINE['ta']]}])
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        out = real(c, ops, **kw)
        client.after_write['d1'] = document('d1', 'Story', [{'words': [MINE['ka'], 'ta']}], version=9)
        return out
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    assert runner(job).document('d1') == 'done'
    mark = _mark(client, 'd1-s1')
    assert [x for x in mark['left'] if x['form']] == [] and mark['counts'].get('left', 0) == 0, mark
    assert mark['counts']['words'] == 1


def test_a_translation_the_starter_clears_under_the_lock_is_not_listed_left_blank(monkeypatch):
    def translate(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        return reply(calls=[call(1, 'set_field', {'document': 'Story', 'refs': ['s1'], 'field': 'Translation',
                                                  'value': 'T1.'})])
    client, job, clock, model = _job(monkeypatch, 'Translate the empty translations.', [{'words': ['ka']}],
                                     [{'words': ['ka'], 'translation': ('T1.', J)}], translate)
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        out = real(c, ops, **kw)
        client.after_write['d1'] = document('d1', 'Story', [{'words': ['ka']}], version=9)
        return out
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    assert runner(job).document('d1') == 'done'
    mark = _mark(client, 'd1-s1')
    assert [x for x in mark['left'] if not x['form']] == [] and mark['counts'].get('left_translations', 0) == 0, mark


# --- a sentence's other values are not its translation (REV-JG-11) -------------------------

def _notes_project():
    """The job project with a second sentence field, Notes, after the
    translation."""
    from job_fixtures import job_project
    from fixtures import SENT_LAYER
    p = job_project()
    for tl in p['text_layers']:
        for tk in tl['token_layers']:
            if tk['id'] == SENT_LAYER:
                tk['span_layers'].append({'id': 'sl-notes', 'name': 'Notes', 'config': {'igt': {'scope': 'Sentence'}}})
    return p


def test_a_sentence_value_the_job_writes_counts_as_a_translation_only_in_the_translation_field(monkeypatch):
    """The job writes Notes on s1 and the translation of s2. Only s2's is
    counted as a translation, s1's empty translation is listed as left
    blank, and s1's writing row says nothing of a translation and names no
    sentence among its words."""
    before = [{'words': ['ka']}, {'words': ['sa']}]
    after = [{'words': ['ka']}, {'words': ['sa'], 'translation': ('T2.', J)}]
    client = JobClient({'d1': document('d1', 'Story', before)}, project=_notes_project())
    client.after_write['d1'] = document('d1', 'Story', after, version=2)
    job = start(client, 'Translate the sentences.', id=J)

    def model(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        return reply(calls=[call(1, 'set_field', {'document': 'Story', 'refs': ['s1'], 'field': 'Notes',
                                                  'value': 'N1.'}),
                            call(2, 'set_field', {'document': 'Story', 'refs': ['s2'], 'field': 'Translation',
                                                  'value': 'T2.'})])
    use(monkeypatch, Model(model))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', client.jobs.rows[J]['message']
    row = json.loads(next(r['analysis'] for (f, _), r in client.jobs.decision_rows[J].items()
                          if f == WRITING_FORM + 'd1-s1'))
    assert row['translation'] is None and row['words'] == [], row
    report = finished['report']
    assert report['totals']['translations'] == 1
    assert [x['ref'] for x in report['documents'][0]['left']] == ['s1'], report['documents'][0]['left']


# --- a write that leaves no stamp of the job (ruling 17) ----------------------------------

_DOUBLED = [{'words': [('ka', [('ka', 'go')], 'human')], 'translation': ('One.', 'human')},
            {'words': ['sa', 'sa'], 'translation': ('Two.', 'human')}]
_UNDOUBLED = [_DOUBLED[0], {'words': ['sa'], 'translation': ('Two.', 'human')}]


def _undouble(asked, n, kwargs):
    """Deletes the second word of s2 whenever s2 is its piece: run twice on
    s2, it deletes a second, different word."""
    if n > 1 or 2 not in targets_named(asked):
        return reply('Done.')
    return reply(calls=[call(1, 'delete_word', {'document': 'Story', 'refs': ['s2.w2']})])


def test_a_deletion_that_landed_before_a_crash_is_never_made_again(monkeypatch):
    """BRIEF-JH item 10: a stretch's write that only deletes a word leaves
    nothing of the job in its sentence. It lands, the worker dies before the
    record, nobody writes since. The sentence no longer reads as it did
    before the write (its writing row's digest), so the write landed: it is
    recorded, never a target again, and no second word is deleted."""
    client, job, clock, model = _job(monkeypatch, 'Delete the doubled words.', _DOUBLED, _UNDOUBLED, _undouble)
    staged = _staged(monkeypatch)
    _crash_at_record(monkeypatch, job)
    assert [o['kind'] for o in staged] == ['delete_word']
    assert _resume(client, job).document('d1') == 'done'
    assert [o['kind'] for o in staged] == ['delete_word'], 'one deletion, never a second'
    assert len([c for c in model.calls if c['n'] == 1]) == 1, 'the model is not asked again'
    assert _mark(client, 'd1-s2')['counts'].get('analyzed') == 1
    assert not _skipped(job)


def test_a_deletion_that_never_landed_before_a_crash_is_made_on_the_resume(monkeypatch):
    """The guard: the writing row was sent, the write was not. The sentence
    reads as before, nobody wrote since: it is a target again, and its one
    deletion is made then."""
    client, job, clock, model = _job(monkeypatch, 'Delete the doubled words.', _DOUBLED, _UNDOUBLED, _undouble)
    _crash_before_write(monkeypatch, job)
    assert _writing(client) == ['d1-s2'] and not client.batches
    client.after_write.pop('d1')
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        client.after_write['d1'] = document('d1', 'Story', _UNDOUBLED, version=3)
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    assert _resume(client, job).document('d1') == 'done'
    assert len([c for c in model.calls if c['n'] == 1]) == 2, 'asked again, as nothing landed'
    assert not _skipped(job)


_REPEATED = [{'words': ['ka']}, {'words': ['sa']}, {'words': ['sa']}, {'words': ['sa']}]


def _unrepeat(asked, n, kwargs):
    """Deletes the last sentence of its piece when it reads as the one
    before it: run twice over what is left, it deletes a second, different
    sentence."""
    if n > 1:
        return reply('Done.')
    piece = targets_named(asked)
    if len(piece) < 2:
        return reply('Done.')
    return reply(calls=[call(1, 'delete_sentence', {'document': 'Story', 'refs': [f's{piece[-1]}']})])


def test_a_sentence_deletion_that_landed_before_a_crash_is_never_made_again(monkeypatch):
    """BRIEF-JS: a stretch's write that deletes a sentence leaves no sentence
    to record. It lands, the worker dies before the record, nobody writes
    since. No second sentence is deleted."""
    client, job, clock, model = _job(monkeypatch, 'Delete a sentence that repeats the one before it.', _REPEATED,
                                     _REPEATED[:3], _unrepeat)
    staged = _staged(monkeypatch)
    _crash_at_record(monkeypatch, job)
    assert [(o['kind'], o['sentence_id']) for o in staged] == [('delete_sentence', 'd1-s4')]
    assert _writing(client) == ['d1-s1', 'd1-s2', 'd1-s3', 'd1-s4'], 'a row for every sentence of the piece'
    assert _resume(client, job).document('d1') == 'done'
    assert [o['kind'] for o in staged] == ['delete_sentence'], 'one deletion, never a second'
    assert len([c for c in model.calls if c['n'] == 1]) == 1, 'the model is not asked again'
    assert _mark(client, 'd1-s4')['counts'] == {'analyzed': 1}
    assert all(_mark(client, f'd1-s{i}') for i in (1, 2, 3)) and not _skipped(job)


def test_a_sentence_the_jobs_write_deleted_is_not_left_blank(monkeypatch):
    """REV-JSF-4: the write deletes s4, whose word and translation are
    blank. Its record holds nothing left blank, as the record a crash leaves
    (above): the report's Left blank and the final context's "left" count
    only what is still there."""
    client, job, clock, model = _job(monkeypatch, 'Delete a sentence that repeats the one before it.', _REPEATED,
                                     _REPEATED[:3], _unrepeat)
    assert runner(job).document('d1') == 'done'
    assert _mark(client, 'd1-s4')['counts'] == {'analyzed': 1}
    assert not _mark(client, 'd1-s4')['left']
    assert not any(e['sentence_id'] == 'd1-s4' for e in runner(job).left_blank(job).get('d1', [])), 'not listed'
    counts = job.rows['d1']['counts']
    assert (counts['left'], counts['left_translations']) == (3, 3), 's1 to s3, not s4'


def test_a_sentence_deletion_that_never_landed_before_a_crash_is_made_on_the_resume(monkeypatch):
    """The guard: the rows were sent, the write was not. Every sentence
    reads as before and none is gone: the piece is taken again, and its one
    deletion is made then."""
    client, job, clock, model = _job(monkeypatch, 'Delete a sentence that repeats the one before it.', _REPEATED,
                                     _REPEATED[:3], _unrepeat)
    _crash_before_write(monkeypatch, job)
    client.after_write.pop('d1')
    staged = _staged(monkeypatch)
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        client.after_write['d1'] = document('d1', 'Story', _REPEATED[:3], version=3)
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    assert _resume(client, job).document('d1') == 'done'
    assert len([c for c in model.calls if c['n'] == 1]) == 2, 'asked again, as nothing landed'
    assert [(o['kind'], o['sentence_id']) for o in staged] == [('delete_sentence', 'd1-s4')]
    assert not _skipped(job)


# --- a later piece writes where an earlier piece wrote (REV-JH-1) ---------------------------

def _two_pieces(monkeypatch, second):
    """Stretches of one sentence: piece 1 glosses ka in s1, piece 2 glosses
    sa in s2 and stages ``second`` (more calls) in s1, its context. The
    batches each write sent, and the job."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)

    def model(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        if targets_named(asked) == [1]:
            return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1',
                                                         'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]})])
        return reply(calls=[call(2, 'set_analysis', {'document': 'Story', 'ref': 's2.w1',
                                                     'morphemes': [{'form': 'sa', 'fields': {'Morph Gloss': 'go'}}]}),
                            *second])
    before = [{'words': ['ka'], 'translation': ('One.', 'human')}, {'words': ['sa'], 'translation': ('Two.', 'human')}]
    after = [{'words': [('ka', [('ka', 'go')], J)], 'translation': ('One.', 'human')},
             {'words': ['sa'], 'translation': ('Two.', 'human')}]
    client, job, clock, m = _job(monkeypatch, 'Gloss and link every word.', before, after, model)
    batches = []
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        batches.append(ops)
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    assert runner(job).document('d1') == 'done'
    return client, job, batches


def test_a_later_piece_links_a_morpheme_an_earlier_piece_analysed(monkeypatch):
    """REV-JH-1: piece 2 is shown s1 as context and links the morpheme piece
    1 analysed there. The link is written with piece 2's analysis of s2."""
    client, job, batches = _two_pieces(monkeypatch, [call(3, 'link_entry', {'document': 'Story', 'refs': ['s1.w1.m1'],
                                                                             'entry_id': 'vi-gam'})])
    assert [sorted(o['kind'] for o in b) for b in batches] == [['set_analysis'], ['link', 'set_analysis']]
    counts = job.rows['d1']['counts']
    assert counts['changes'] == 3 and not counts.get('proposed') and not counts.get('repeated'), counts


def test_a_later_piece_corrects_an_earlier_pieces_gloss(monkeypatch):
    """Ruling 17: piece 2 corrects the gloss piece 1 wrote on ka. Written."""
    client, job, batches = _two_pieces(monkeypatch, [call(3, 'set_analysis', {
        'document': 'Story', 'ref': 's1.w1', 'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'went'}}]})])
    second = [(o['kind'], o.get('word_id')) for o in batches[1]]
    assert ('set_analysis', 'd1-s1w1') in second, second
    assert job.rows['d1']['counts']['changes'] == 3


def test_a_writing_row_names_the_piece_that_wrote(monkeypatch):
    """Each sentence's writing row names the piece whose write it was for:
    s1's names piece 1 and piece 2 (its link), s2's piece 2 only."""
    client, job, batches = _two_pieces(monkeypatch, [call(3, 'link_entry', {'document': 'Story', 'refs': ['s1.w1.m1'],
                                                                             'entry_id': 'vi-gam'})])
    pieces = {}
    for (f, _), r in client.jobs.decision_rows[J].items():
        if f.startswith(WRITING_FORM):
            pieces.setdefault(f[len(WRITING_FORM):], set()).update(json.loads(r['analysis'])['pieces'])
    assert len(pieces['d1-s1']) == 2 and len(pieces['d1-s2']) == 1 and pieces['d1-s2'] < pieces['d1-s1'], pieces


# --- the digest reads only what a write in the sentence changes (REV-JH-3) ------------------

def test_the_digest_reads_neither_the_sentence_index_nor_an_entry_form():
    """A sentence moved by a merge or a deletion before it, or one whose
    linked entry was renamed in the lexicon, has the digest it had: neither
    is something a write in the sentence does. A link's entry still counts."""
    import dataclasses
    from fixtures import PID
    from plaid_agent.igt.project import Link, load_document, load_project
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka', 'ta']}, {'words': ['sa']}])})
    doc = load_document(client, load_project(client, PID), 'd1')
    s = doc.sentences[1]
    d0 = igt_job.sentence_digest(s)
    assert igt_job.sentence_digest(dataclasses.replace(s, index=1)) == d0, 'the index'
    m = s.words[0].morphemes[0]
    m.link = Link(id='l1', item_id='vi-gam', form='gam', vocab_id='v', members=[(2, 1)])
    linked = igt_job.sentence_digest(s)
    assert linked != d0, 'a link made'
    m.link = Link(id='l1', item_id='vi-gam', form='gaam', vocab_id='v', members=[(1, 1)])
    assert igt_job.sentence_digest(s) == linked, 'the entry renamed, the sentence moved'
    m.link = Link(id='l1', item_id='vi-gem', form='gaam', vocab_id='v')
    assert igt_job.sentence_digest(s) != linked, 'another entry'
    s.words[0].mwes = [Link(id='l2', item_id='vi-x', form='x', vocab_id='v', tokens=['a', 'b'], members=[(2, 1)])]
    with_mwe = igt_job.sentence_digest(s)
    s.words[0].mwes = [Link(id='l2', item_id='vi-x', form='y', vocab_id='v', tokens=['a', 'b'], members=[(1, 1)])]
    assert igt_job.sentence_digest(s) == with_mwe, "an expression's entry renamed, its sentence moved"


def test_an_entry_renamed_while_the_worker_is_down_does_not_read_as_a_deletion_that_landed(monkeypatch):
    """REV-JH-3: the writing row is sent, the worker dies before the write
    that deletes the doubled sa. While it is down a person renames gam, which
    a morpheme of s2 links, on the Entries screen (no unit in the document's
    History). s2 reads as it did before the write: a target again, and its
    one deletion is made on the resume."""
    doubled = [{'words': [('ka', [('ka', 'go', 'vi-gam')], 'human')], 'translation': ('One.', 'human')},
               {'words': [('sa', [('sa', 'go', 'vi-gam')], 'human'), 'sa'], 'translation': ('Two.', 'human')}]
    undoubled = [doubled[0], {'words': [('sa', [('sa', 'go', 'vi-gam')], 'human')], 'translation': ('Two.', 'human')}]
    client, job, clock, model = _job(monkeypatch, 'Delete the doubled words.', doubled, undoubled, _undouble)
    _crash_before_write(monkeypatch, job)
    assert _writing(client) == ['d1-s2'] and not client.batches
    client.after_write.pop('d1')
    raw = client._holder('d1')['documents']['d1']
    for tl in raw['text_layers'][0]['token_layers']:
        for v in tl.get('vocabs') or []:
            for link in v['vocab_links']:
                link['vocab_item']['form'] = 'gaam'
    real = igt_job.execute_plan
    staged = []

    def execute(c, ops, **kw):
        staged.extend(ops)
        client.after_write['d1'] = document('d1', 'Story', undoubled, version=3)
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    assert _resume(client, job).document('d1') == 'done'
    assert len([c for c in model.calls if c['n'] == 1]) == 2, 'asked again, as nothing landed'
    assert [o['kind'] for o in staged] == ['delete_word']
    assert not _skipped(job)


# --- a write landed only when a sentence its own rows delete is gone (REV-JSF-1, -2) --------

def _renamed(raw, mapping):
    """``raw`` with each id of ``mapping`` renamed, in order."""
    text = json.dumps(raw)
    for a, b in mapping:
        text = text.replace(a, b)
    return json.loads(text)


_LINES = [{'words': ['ka']}, {'words': ['xa']}, {'words': ['sa']}, {'words': ['ta']}]
# After s2 is deleted: ka, sa (d1-s3), ta (d1-s4).
_LINES_LEFT = _renamed(document('d1', 'Story', [_LINES[0], _LINES[2], _LINES[3]], version=2),
                       [('d1-s3', 'd1-s4'), ('d1-s2', 'd1-s3')])


def _delete_before_sa(asked, n, kwargs):
    """Deletes the sentence before its piece when its piece reads sa: run
    again over what is left, it deletes another sentence."""
    if n > 1:
        return reply('Done.')
    k = targets_named(asked)[0]
    if k > 1 and f'[s{k}] sa.' in asked:
        return reply(calls=[call(1, 'delete_sentence', {'document': 'Story', 'refs': [f's{k - 1}']})])
    return reply('Done.')


def _lines_job(monkeypatch):
    """Stretches of one sentence over ka. xa. sa. ta.: piece s3 (s1 and s2
    its context) deletes s2, which piece s2 recorded."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)
    client, job, clock, model = _job(monkeypatch, 'Delete the line before each line reading sa.', _LINES,
                                     model=_delete_before_sa)
    client.after_write['d1'] = _LINES_LEFT
    return client, job, model


def test_a_later_pieces_deletion_of_a_recorded_sentence_that_landed_before_a_crash_is_never_made_again(monkeypatch):
    """REV-JSF-1, the crash: piece s3's write deletes s2, which piece s2
    recorded, and the worker dies before the record. s3 reads as before and
    nothing of the job is in it, but its own row says the write deletes s2,
    which is gone: the write landed, s3 is recorded and no second sentence is
    deleted."""
    client, job, model = _lines_job(monkeypatch)
    staged = _staged(monkeypatch)
    real = job.add_decisions

    def add(decisions):
        if any(d['form'] == RECORD_FORM + 'd1-s3' for d in decisions):
            raise Crash()
        return real(decisions)
    monkeypatch.setattr(job, 'add_decisions', add)
    with pytest.raises(Crash):
        runner(job).document('d1')
    monkeypatch.setattr(job, 'add_decisions', real)
    asked = len([c for c in model.calls if c['n'] == 1])
    assert _resume(client, job).document('d1') == 'done'
    assert [(o['kind'], o['sentence_id']) for o in staged] == [('delete_sentence', 'd1-s2')], 'one deletion only'
    assert len([c for c in model.calls if c['n'] == 1]) == asked + 1, 'only ta, the last piece, is asked on the resume'
    assert _mark(client, 'd1-s3')['counts'].get('analyzed') == 1


def test_a_later_pieces_deletion_of_a_recorded_sentence_whose_answer_is_lost_is_never_made_again(monkeypatch):
    """REV-JSF-1, the lost answer: the same write lands and core's answer is
    lost (a proxy's 502 at the operation's end). The same worker settles
    the document: s2 is gone though recorded, and s3's row names it, so s3
    is recorded and its piece is not run again over what is left."""
    client, job, model = _lines_job(monkeypatch)
    staged = _staged(monkeypatch)
    real_op, once = client.operation, {'n': 1}

    @contextlib.contextmanager
    def operation(*args, **kwargs):
        with real_op(*args, **kwargs) as op:
            yield op
        if once['n'] and kwargs.get('kind') == 'job' and staged:
            once['n'] = 0
            raise PlaidAPIError('HTTP 502', status=502, method='POST')
    monkeypatch.setattr(client, 'operation', operation)
    assert runner(job).document('d1') == 'done'
    assert not once['n'], 'the answer was lost'
    assert [(o['kind'], o['sentence_id']) for o in staged] == [('delete_sentence', 'd1-s2')], 'one deletion only'
    pieces = [targets_named(c['asked'])[0] for c in model.calls if c['n'] == 1]
    assert pieces == [1, 2, 3, 3], f'each piece asked once, ta last as s3: {pieces}'
    assert job.rows['d1']['counts'].get('deletions') in (None, 0, 1)


def _gloss_or_unrepeat(asked, n, kwargs):
    """Deletes its sentence when it reads as the one before it, else glosses
    its word."""
    if n > 1:
        return reply('Done.')
    k = targets_named(asked)[0]
    mine = re.search(rf'^\[s{k}\] (\S+)\.', asked, re.M).group(1)
    prev = re.search(rf'^\[s{k - 1}\] (\S+)\.', asked, re.M) if k > 1 else None
    if prev and prev.group(1) == mine:
        return reply(calls=[call(1, 'delete_sentence', {'document': 'Story', 'refs': [f's{k}']})])
    return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'ref': f's{k}.w1',
                                                 'morphemes': [{'form': mine, 'fields': {'Morph Gloss': 'go'}}]})])


def test_the_jobs_own_earlier_deletion_does_not_make_a_later_write_that_never_landed_read_as_landed(monkeypatch):
    """REV-JSF-2, no person at all: ka. ka. sa. ta. in stretches of one.
    Piece s2 deletes itself (recorded as usual), piece s3 glosses sa, piece
    s4's writing row is sent and the worker dies before its write. On the
    resume s2 is gone, but no row of s4 names it: s4 reads as before, so it
    is a target again, asked and glossed."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)
    before = [{'words': ['ka']}, {'words': ['ka']}, {'words': ['sa']}, {'words': ['ta']}]
    client, job, clock, model = _job(monkeypatch, 'Delete a sentence that repeats the one before it, and gloss '
                                     'every word.', before, model=_gloss_or_unrepeat)
    g = lambda f: (f, [(f, 'go')], J)  # noqa: E731
    states = {
        1: document('d1', 'Story', [{'words': [g('ka')]}, *before[1:]], version=2),
        2: _renamed(document('d1', 'Story', [{'words': [g('ka')]}, before[2], before[3]], version=3),
                    [('d1-s3', 'd1-s4'), ('d1-s2', 'd1-s3')]),
        3: _renamed(document('d1', 'Story', [{'words': [g('ka')]}, {'words': [g('sa')]}, before[3]], version=4),
                    [('d1-s3', 'd1-s4'), ('d1-s2', 'd1-s3')]),
    }
    real, n, sent = igt_job.execute_plan, {'n': 0}, []

    def execute(c, ops, **kw):
        n['n'] += 1
        if n['n'] > 3:
            raise Crash()
        sent.extend((o['kind'], o.get('word_id') or o.get('sentence_id')) for o in ops)
        if n['n'] == 2:
            # The deletion reads the text as it is before it.
            out = real(c, ops, **kw)
            client.after_write['d1'] = states[2]
            client.document_versions['d1'] = 3
            return out
        client.after_write['d1'] = states[n['n']]
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    with pytest.raises(Crash):
        runner(job).document('d1')
    assert sent == [('set_analysis', 'd1-s1w1'), ('delete_sentence', 'd1-s2'), ('set_analysis', 'd1-s3w1')], sent
    assert 'd1-s4' in _writing(client)
    asked = len([c for c in model.calls if c['n'] == 1])
    monkeypatch.setattr(igt_job, 'execute_plan', lambda c, ops, **kw: (sent.extend(
        (o['kind'], o.get('word_id') or o.get('sentence_id')) for o in ops), real(c, ops, **kw))[1])
    assert _resume(client, job).document('d1') == 'done'
    assert len([c for c in model.calls if c['n'] == 1]) == asked + 1, 'piece s4 is asked again'
    assert sent[3:] == [('set_analysis', 'd1-s4w1')], sent
    assert sent.count(('delete_sentence', 'd1-s2')) == 1


def test_a_sentence_a_person_deleted_does_not_make_a_later_write_that_never_landed_read_as_landed(monkeypatch):
    """REV-JSF-2 with a person: ka. sa. ta. in stretches of one. The job
    glosses s1 and records it, a person deletes s1 on the Baseline tab,
    piece s2 (old s2) glosses sa, which makes the document quiet again, and
    the worker dies after piece s3's writing row, before its write. On the
    resume s1 is gone, but no row of s3 names it: s3 is asked and glossed."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)
    before = [{'words': ['ka']}, {'words': ['sa']}, {'words': ['ta']}]

    def model(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        k = targets_named(asked)[0]
        return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'ref': f's{k}.w1',
                                                     'morphemes': [{'form': 'xx', 'fields': {'Morph Gloss': 'go'}}]})])
    client, job, clock, m = _job(monkeypatch, 'Gloss every word.', before, model=model)
    real, n, sent = igt_job.execute_plan, {'n': 0}, []

    def execute(c, ops, **kw):
        n['n'] += 1
        if n['n'] == 1:
            client.after_write['d1'] = document('d1', 'Story', [{'words': [('ka', [('ka', 'go')], J)]}] + before[1:],
                                                version=2)
        elif n['n'] == 2:
            client.after_write['d1'] = _renamed(document('d1', 'Story', [{'words': [('sa', [('sa', 'go')], J)]},
                                                                         before[2]], version=4),
                                                [('d1-s2', 'd1-s3'), ('d1-s1', 'd1-s2')])
        else:
            raise Crash()
        sent.extend((o['kind'], o.get('word_id')) for o in ops)
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    real_add, done = job.add_decisions, {'n': 0}

    def add(decisions):
        real_add(decisions)
        if not done['n'] and any(d['form'] == RECORD_FORM + 'd1-s1' for d in decisions):
            done['n'] = 1
            # A person deletes s1, which the job glossed, on the Baseline tab.
            raw = _renamed(document('d1', 'Story', before[1:], version=3), [('d1-s2', 'd1-s3'), ('d1-s1', 'd1-s2')])
            client.after_write['d1'] = raw
            client._holder('d1')['documents']['d1'] = raw
            history = client._holder('d1')['audit']
            newest = max((e.get('time') or '' for e in history), default='')
            history.append({'id': 'person-x', 'time': newest[:-1] + '9Z', 'ref': None, 'documents': [{'id': 'd1'}],
                            'ops': []})
    monkeypatch.setattr(job, 'add_decisions', add)
    with pytest.raises(Crash):
        runner(job).document('d1')
    monkeypatch.setattr(job, 'add_decisions', real_add)
    assert sent == [('set_analysis', 'd1-s1w1'), ('set_analysis', 'd1-s2w1')], sent
    assert 'd1-s3' in _writing(client)
    asked = len([c for c in m.calls if c['n'] == 1])
    monkeypatch.setattr(igt_job, 'execute_plan', lambda c, ops, **kw: (sent.extend(
        (o['kind'], o.get('word_id')) for o in ops), real(c, ops, **kw))[1])
    assert _resume(client, job).document('d1') == 'done'
    assert len([c for c in m.calls if c['n'] == 1]) == asked + 1, 'piece s3 is asked again'
    assert sent[2:] == [('set_analysis', 'd1-s3w1')], sent


def test_a_document_piece_put_off_after_its_first_batch_deletes_its_sentence_once_when_taken_up_again(monkeypatch):
    """REV-JS-JHFIX, not yet checked: a document piece glosses ka in s1 and
    deletes s3, which repeats s2. Its batch lands, core refuses the
    deletion (409, the starter's own browser wrote), and the document is
    put off. Taken up again, s1 is settled as written, s2 and s3 read as
    before and s3, which the rows name, is still there: the piece runs
    again, its gloss of s1 is left out as written, and s3 is deleted once."""
    before = [{'words': ['ka']}, {'words': ['sa']}, {'words': ['sa']}]
    glossed = [{'words': [MINE['ka']]}, {'words': ['sa']}, {'words': ['sa']}]
    client = JobClient({'d1': document('d1', 'Story', before)})
    client.after_write['d1'] = document('d1', 'Story', glossed, version=2)
    clock = {'t': 1_800_000_000.0}
    job = start(client, 'Gloss ka and delete a sentence that repeats the one before it.', id=J,
                now=lambda: clock['t'], plan='document')
    job._sleep = lambda s: clock.__setitem__('t', clock['t'] + s)
    job.job['created_at'] = _iso(clock['t'] - 3600)

    def model(asked, n, kwargs):
        if n > 1 or 'Your piece: the whole document' not in asked:
            return reply('Done.')
        return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1', 'morphemes': [
            {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]}),
            call(2, 'delete_sentence', {'document': 'Story', 'refs': ['s3']})])
    m = use(monkeypatch, Model(model))
    staged = _staged(monkeypatch)
    real_edit, edits = client.texts.edit, []

    def edit(*args, **kwargs):
        edits.append('refused' if not edits else 'landed')
        if len(edits) == 1:
            raise PlaidAPIError('HTTP 409 version', status=409, method='POST')
        out = real_edit(*args, **kwargs)
        client.after_write['d1'] = document('d1', 'Story', glossed[:2], version=3)
        return out
    monkeypatch.setattr(client.texts, 'edit', edit)
    runner(job).work(job)
    assert edits == ['refused', 'landed'], edits
    assert len([c for c in m.calls if c['n'] == 1 and 'Your piece: the whole document' in c['asked']]) == 2
    assert [o['word_id'] for o in staged if o['kind'] == 'set_analysis'] == ['d1-s1w1'], 'glossed once'
    assert [o['sentence_id'] for o in staged if o['kind'] == 'delete_sentence'] == ['d1-s3', 'd1-s3']
    row = job.rows['d1']
    assert row['state'] == 'done' and not row.get('skipped'), row
    assert row['counts']['repeated'] == 1 and row['counts']['deletions'] == 1, row['counts']
