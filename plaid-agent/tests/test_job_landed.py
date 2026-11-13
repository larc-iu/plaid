"""A write of several tries (one request each, BRIEF RX): what landed of it
is known from core, try by try, after a lost answer in the middle, a crash
between two tries, or a refusal after the first landed. Nothing is written
twice, nothing vanishes unlisted: a sentence a write landed in part is listed
"Write interrupted", and a piece whose write was cut short is taken again over
what is left."""

import json

import pytest

from job_fixtures import JobClient, Model, call, document, reply, runner, start, targets_named, use

from plaid_client import PlaidAPIError
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import WRITING_FORM
from test_job_vouched import _iso
from test_job_writing import _renamed

J = 'JL'
KA = ('ka', [('ka', 'go')], J)
FOUR = [{'words': ['ka']}, {'words': ['sa']}, {'words': ['sa']}, {'words': ['sa']}]
# s1 glossed, s3 deleted: ka, sa, sa (d1-s4).
THREE = _renamed(document('d1', 'Story', [{'words': [KA]}, FOUR[1], FOUR[3]], version=3), [('d1-s3', 'd1-s4')])
TWO = document('d1', 'Story', [{'words': [KA]}, FOUR[1]], version=4)


class Crash(BaseException):
    """The worker's process dies here."""


def _undouble(asked, n, kwargs):
    """The first piece glosses ka and deletes each sentence that repeats the
    one before it (s3 and s4). Taken again, it deletes the last of its
    piece when it repeats the one before."""
    if n > 1:
        return reply('Done.')
    piece = targets_named(asked)
    if piece == [1, 2, 3, 4]:
        return reply(calls=[call(1, 'set_analysis', {'document': 'Story', 'ref': 's1.w1', 'morphemes': [
            {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]}),
            call(2, 'delete_sentence', {'document': 'Story', 'refs': ['s3']}),
            call(3, 'delete_sentence', {'document': 'Story', 'refs': ['s4']})])
    if len(piece) > 1:
        return reply(calls=[call(4, 'delete_sentence', {'document': 'Story', 'refs': [f's{piece[-1]}']})])
    return reply('Done.')


def _job(monkeypatch, model=_undouble):
    client = JobClient({'d1': document('d1', 'Story', FOUR)})
    client.after_write['d1'] = document('d1', 'Story', [{'words': [KA]}, *FOUR[1:]], version=2)
    clock = {'t': 1_800_000_000.0}
    job = start(client, 'Gloss ka and delete each sentence that repeats the one before it.', id=J,
                now=lambda: clock['t'])
    job._sleep = lambda s: clock.__setitem__('t', clock['t'] + s)
    job.job['created_at'] = _iso(clock['t'] - 3600)
    m = use(monkeypatch, Model(model))
    return client, job, m


def _edits(monkeypatch, client, fates):
    """Each sentence deletion's request answered as ``fates`` says, by its
    place (``lost``: it lands and its answer is lost, ``refused``: 409), and
    the document after each that lands. The deletions sent, in order."""
    real, sent = client.texts.edit, []

    def edit(*args, **kwargs):
        sent.append(len(sent) + 1)
        fate = fates.get(len(sent))
        if fate == 'refused':
            raise PlaidAPIError('HTTP 409 version', status=409, method='POST')
        out = real(*args, **kwargs)
        client.after_write['d1'] = {1: THREE, 2: TWO}[len([f for f in sent if fates.get(f) != 'refused'])]
        if fate == 'lost':
            raise PlaidAPIError('HTTP 502', status=502, method='POST')
        return out
    monkeypatch.setattr(client.texts, 'edit', edit)
    return sent


def _asked(model):
    return [targets_named(c['asked']) for c in model.calls if c['n'] == 1]


def _skipped(job):
    return [(s['sentence_id'], s['reason']) for s in job.rows['d1'].get('skipped') or []]


def test_a_lost_answer_in_the_middle_of_a_write_sends_nothing_twice_and_takes_the_rest_again(monkeypatch):
    """Three tries: the gloss, s3's deletion, s4's. s3's lands and its
    answer is lost, so s4's is never sent. Taken again, core says the gloss
    and s3's deletion landed: the piece is taken again over s2 and s4 (now
    s3), and s4 is deleted once. Each deletion and the gloss once, nothing
    listed."""
    client, job, model = _job(monkeypatch)
    sent = _edits(monkeypatch, client, {1: 'lost'})
    assert runner(job).document('d1') == 'done'
    assert sent == [1, 2], 'one deletion each'
    assert len(client.batches) == 1, 'the gloss once'
    assert _asked(model) == [[1, 2, 3, 4], [2, 3]], 'taken again over what is left'
    assert _skipped(job) == []
    counts = job.rows['d1']['counts']
    assert counts['deletions'] == 2 and counts['words'] == 1, counts


def test_a_crash_between_two_tries_sends_nothing_twice_and_takes_the_rest_again(monkeypatch):
    """The same write, the worker dying after s3's deletion landed, before
    s4's rows: a new worker asks core and takes the piece again over what is
    left."""
    client, job, model = _job(monkeypatch)
    sent = _edits(monkeypatch, client, {})
    real, n = igt_job.IgtRunner.intend, {'n': 0}

    def intend(self, w, seed, ops, drops):
        if seed is not None:
            n['n'] += 1
            if n['n'] == 3:
                raise Crash()
        return real(self, w, seed, ops, drops)
    monkeypatch.setattr(igt_job.IgtRunner, 'intend', intend)
    with pytest.raises(Crash):
        runner(job).document('d1')
    monkeypatch.setattr(igt_job.IgtRunner, 'intend', real)
    job.rows = {r['document_id']: dict(r) for r in client.jobs.get(J)['documents']}
    assert runner(job).document('d1') == 'done'
    assert sent == [1, 2] and len(client.batches) == 1
    assert _asked(model) == [[1, 2, 3, 4], [2, 3]]
    assert _skipped(job) == [] and job.rows['d1']['counts']['deletions'] == 2


def _two_words(monkeypatch, cap, refused=(), after=None):
    """ka ta. sa. glossed whole in one piece, the request cap at ``cap``
    writes (a set_analysis of one morpheme is two), the n-th request of
    ``refused`` refused (409, the starter's own browser wrote). The
    requests sent, and the runner."""
    from plaid_agent.core import plan as core_plan
    from plaid_client import testing
    monkeypatch.setattr(core_plan, 'MAX_BATCH_OPS', cap)
    words = {1: ['ka', 'ta'], 2: ['sa']}

    def model(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        return reply(calls=[call(10 * k + i, 'set_analysis', {'document': 'Story', 'ref': f's{k}.w{i}', 'morphemes': [
            {'form': f, 'fields': {'Morph Gloss': 'go'}}]}) for k in targets_named(asked)
            for i, f in enumerate(words[k], start=1)])
    client = JobClient({'d1': document('d1', 'Story', [{'words': ['ka', 'ta']}, {'words': ['sa']}])})
    client.after_write['d1'] = document('d1', 'Story', after or [{'words': [KA, ('ta', [('ta', 'go')], J)]},
                                                                 {'words': [('sa', [('sa', 'go')], J)]}], version=2)
    clock = {'t': 1_800_000_000.0}
    job = start(client, 'Gloss every word.', id=J, now=lambda: clock['t'])
    job._sleep = lambda s: clock.__setitem__('t', clock['t'] + s)
    job.job['created_at'] = _iso(clock['t'] - 3600)
    use(monkeypatch, Model(model))
    real, sent = testing._Batch.submit, []

    def submit(self):
        sent.append(sorted({k for k, _ in self.queued}))
        if len(sent) in refused:
            self.open = False
            raise PlaidAPIError('HTTP 409 version', status=409, method='POST')
        return real(self)
    monkeypatch.setattr(testing._Batch, 'submit', submit)
    return client, job, sent


def test_a_write_too_big_for_one_request_is_cut_at_a_sentence_before_anything_is_sent(monkeypatch):
    """Three analyses do not fit a request of four writes: the try is cut
    at the sentence boundary before it is sent, s1's two analyses (four
    writes) in one request and s2's in another, each under its own seed."""
    client, job, sent = _two_words(monkeypatch, 4)
    assert runner(job).document('d1') == 'done'
    assert len(sent) == 2 and len(client.landed_keys) == 2 and all(k.endswith('.0') for k in client.landed_keys)
    assert _skipped(job) == [] and job.rows['d1']['counts']['words'] == 3


def test_a_sentence_too_big_for_one_request_written_in_part_is_listed_and_never_written_again(monkeypatch):
    """One analysis a request: s1's two analyses are cut into two tries. The
    first lands, core refuses the second (409): put off. Back, core says s1
    was written in part: listed "Write interrupted", never written again,
    and what landed is counted."""
    client, job, sent = _two_words(monkeypatch, 2, refused=(2,), after=[{'words': [KA, 'ta']}, {'words': ['sa']}])
    r = runner(job)
    assert r.document('d1') == 'deferred'
    assert r.document('d1') == 'done'
    assert sent[0] == ['spans.create', 'tokens.create'] and len(sent) == 3, 'ka, ta refused, sa: nothing again'
    assert _skipped(job) == [('d1-s1', 'interrupted')]
    assert job.rows['d1']['counts']['words'] == 2, 'ka and sa'


def test_a_later_pieces_deletion_refused_after_its_gloss_landed_lists_the_sentence(monkeypatch):
    """REV-JSF-1's shape: piece s3 (s2 its context, which piece s2 wrote)
    glosses s3 and deletes s2. The gloss lands, the deletion is refused: s3
    is written, its piece is not run again (no second deletion), and s2,
    where a write that landed in part did not land, is listed."""
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 1)

    def model(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        k = targets_named(asked)[0]
        calls = [call(1, 'set_analysis', {'document': 'Story', 'ref': f's{k}.w1', 'morphemes': [
            {'form': 'x', 'fields': {'Morph Gloss': 'go'}}]})]
        if k == 3:
            calls.append(call(2, 'delete_sentence', {'document': 'Story', 'refs': ['s2']}))
        return reply(calls=calls)
    client, job, m = _job(monkeypatch, model)
    sent = _edits(monkeypatch, client, {1: 'refused'})
    r = runner(job)
    assert r.document('d1') == 'deferred'
    assert r.document('d1') == 'done'
    assert sent == [1], 'never sent again'
    assert _asked(m) == [[1], [2], [3], [4]], 'piece s3 is not run again'
    assert _skipped(job) == [('d1-s2', 'interrupted')]


def test_every_try_is_one_request_under_its_own_seed_with_its_rows_first(monkeypatch):
    """Each try of the write is one request, its key the first of its own
    seed, its rows in core before it: core's lookup names every seed the
    rows name."""
    client, job, model = _job(monkeypatch)
    sent = _edits(monkeypatch, client, {})
    assert runner(job).document('d1') == 'done'
    rows = [json.loads(r['analysis']) for (f, _), r in client.jobs.decision_rows[J].items()
            if f.startswith(WRITING_FORM)]
    seeds = {r['try'] for r in rows if r['try']}
    assert len(seeds) == 3 and len(sent) == 2 and len(client.batches) == 1
    assert sorted(client.jobs.landed(J, sorted(seeds))) == sorted(f'{s}.0' for s in seeds)
    assert all(k.endswith('.0') for k in client.landed_keys), 'one request a try'
