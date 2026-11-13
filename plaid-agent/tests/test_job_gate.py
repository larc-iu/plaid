"""THE GATE: every write of a job in a document goes through one write
(``IgtRunner.write``), whatever the plan cut (stretches of sentences, a whole
document, the whole selection), and that write first settles the document
(``IgtRunner.gate``): what the job wrote there and did not record is recorded,
or skipped as interrupted when nothing of the job is left in it. Then its
writing rows, the recheck and the apply rule under the lock, and its record
(REV-JG-1).

Each way into the window between a write and its record that the earlier
reviews found for stretches is tested here for every piece kind: a crash and a
person's deletion, a passing error after the write, a write put off halfway, a
person editing during the piece, a split or a merge after the job wrote, and a
second worker taking the job up. The owner's rule: nothing a person wrote,
confirmed or deleted is changed or put back by a job."""

import json

import pytest

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from plaid_client import PlaidAPIError
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import RECORD_FORM, WRITING_FORM
from test_job_reshape import reshaped
from test_job_vouched import _iso, _person_edits

J = 'JGATE'
PIECES = ['sentences', 'document', 'selection']
MINE = {'ka': ('ka', [('ka', 'go')], J), 'ta': ('ta', [('ta', 'go')], J), 'sa': ('sa', [('sa', 'go')], J),
        'pa': ('pa', [('pa', 'go')], J)}
BLANK = [{'words': ['ka', 'ta'], 'translation': ('One.', 'human')}, {'words': ['sa'], 'translation': ('Two.', 'human')}]
WRITTEN = [{'words': [MINE['ka'], MINE['ta']], 'translation': ('One.', 'human')},
           {'words': [MINE['sa']], 'translation': ('Two.', 'human')}]
REFS = {'s1.w1': 'ka', 's1.w2': 'ta', 's2.w1': 'sa'}


class Crash(BaseException):
    """The worker's process dies here."""


def _gloss(refs=REFS):
    """A piece that glosses every word it was told of, whatever its kind:
    each piece stages all of them, and what the job does with each is the
    job's business. A selection reads the document first, as what a read
    printed is what its piece read (REV-JG3-1)."""
    def answer(asked, n, kwargs):
        if 'Your piece: the whole selection above.' in asked:
            if n == 1:
                return reply(calls=[call(9, 'read_document', {'document': 'Story'})])
            n -= 1
        if n > 1:
            return reply('Glossed the blank words.')
        return reply(calls=[call(i, 'set_analysis', {'document': 'Story', 'ref': r,
                                                     'morphemes': [{'form': f, 'fields': {'Morph Gloss': 'go'}}]})
                            for i, (r, f) in enumerate(refs.items(), start=1)])
    return answer


def _job(monkeypatch, pieces, before=BLANK, after=WRITTEN, model=None):
    client = JobClient({'d1': document('d1', 'Story', before)})
    client.after_write['d1'] = document('d1', 'Story', after, version=2)
    clock = {'t': 1_800_000_000.0}
    job = start(client, 'Gloss every word nobody analysed.', id=J, now=lambda: clock['t'], plan=pieces)
    job._sleep = lambda s: clock.__setitem__('t', clock['t'] + s)
    job.job['created_at'] = _iso(clock['t'] - 3600)
    m = use(monkeypatch, Model(model or _gloss()))
    return client, job, clock, m


def _crash_at_record(monkeypatch, job):
    """The process dies on the record's call, after the write landed."""
    real = job.add_decisions

    def add(decisions):
        if any(d['form'].startswith(RECORD_FORM) for d in decisions):
            raise Crash()
        return real(decisions)
    monkeypatch.setattr(job, 'add_decisions', add)
    with pytest.raises(Crash):
        runner(job).work(job)
    monkeypatch.setattr(job, 'add_decisions', real)


def _resume(client, job):
    """A new worker process: the rows as core has them, a new runner."""
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


def _analysed(staged):
    return sorted(o.get('word_id') for o in staged if o.get('kind') == 'set_analysis')


def _skipped(job):
    return [(s['sentence_id'], s['reason']) for s in job.rows['d1'].get('skipped') or []]


def _writing(client):
    return sorted(f[len(WRITING_FORM):] for f, _ in client.jobs.decision_rows.get(J, {}) if f.startswith(WRITING_FORM))


def _mark(client, sid):
    rows = [r for (f, _), r in client.jobs.decision_rows[J].items() if f == RECORD_FORM + sid]
    assert len(rows) == 1, rows
    return json.loads(rows[0]['analysis'])


def _changes(client):
    return [json.loads(r['analysis']) for (f, _), r in client.jobs.decision_rows.get(J, {}).items()
            if f.startswith(igt_job.CHANGE_FORM)]


# --- one write for every piece ------------------------------------------------------------

@pytest.mark.parametrize('pieces', PIECES)
def test_every_piece_writes_through_the_one_gate(monkeypatch, pieces):
    """Every piece kind's write goes through ``IgtRunner.write``, and that
    write asks the gate first."""
    client, job, clock, model = _job(monkeypatch, pieces)
    r = runner(job)
    seen = {'write': 0, 'gate': 0}
    real_write, real_gate = r.write, r.gate

    def write(*a, **kw):
        seen['write'] += 1
        return real_write(*a, **kw)

    def gate(*a, **kw):
        seen['gate'] += 1
        return real_gate(*a, **kw)
    monkeypatch.setattr(r, 'write', write)
    monkeypatch.setattr(r, 'gate', gate)
    staged = _staged(monkeypatch)
    r.work(job)
    assert seen['write'] >= 1 and seen['gate'] >= seen['write'], seen
    assert _analysed(staged) == ['d1-s1w1', 'd1-s1w2', 'd1-s2w1']
    assert job.rows['d1']['state'] == 'done'


# --- a crash between the write and its record ----------------------------------------------

@pytest.mark.parametrize('pieces', PIECES)
def test_a_crash_after_the_write_and_a_person_clearing_a_sentence_is_never_written_again(monkeypatch, pieces):
    """REV-JG-1 (and REV-FIX3-1 for stretches): the write lands, the worker
    dies before its record, a person clears the job's analyses of s1, and a
    new worker takes the job up. Nothing is written in s1 again, it is listed
    as interrupted, and s2 is recorded as the job wrote it."""
    client, job, clock, model = _job(monkeypatch, pieces)
    _crash_at_record(monkeypatch, job)
    assert _writing(client) == ['d1-s1', 'd1-s2'], 'stored before the write'
    clock['t'] += 3600
    _person_edits(client, 'd1', [{'words': ['ka', 'ta'], 'translation': ('One.', 'human')},
                                 {'words': [MINE['sa']], 'translation': ('Two.', 'human')}], 3, clock)
    clock['t'] += 3600
    staged = _staged(monkeypatch)
    _resume(client, job).work(job)
    assert _analysed(staged) == [], 'nothing the person cleared is written again'
    assert ('d1-s1', 'interrupted') in _skipped(job)
    assert _mark(client, 'd1-s2')['counts']['words'] == 1
    assert job.rows['d1']['state'] == 'done'


@pytest.mark.parametrize('pieces', PIECES)
def test_a_crash_after_the_write_with_nobody_writing_since_is_recorded_whole_and_proposes_nothing(monkeypatch,
                                                                                                 pieces):
    """A second worker takes the job up with nobody having written since:
    everything the job wrote is recorded and vouched for, nothing is
    written twice, and nothing is proposed from the job's analysis to the
    same analysis (REV-JG-1's noise)."""
    client, job, clock, model = _job(monkeypatch, pieces)
    _crash_at_record(monkeypatch, job)
    staged = _staged(monkeypatch)
    _resume(client, job).work(job)
    assert _analysed(staged) == []
    assert not _skipped(job)
    assert job.rows['d1']['counts']['words'] == 3 and job.rows['d1']['state'] == 'done'
    assert len(_mark(client, 'd1-s1')['words']) == 2, 'vouched for'
    assert _changes(client) == []


# --- a passing error after the write --------------------------------------------------------

@pytest.mark.parametrize('pieces', PIECES)
def test_one_passing_error_on_the_record_and_a_person_clearing_a_sentence_in_the_wait(monkeypatch, pieces):
    """The record's call meets a 502 and the starter clears the job's
    analyses of s1 in the 30 s wait. The write is taken again from the gate:
    s1 is left and listed, nothing is written twice, the model is not asked
    again, and the job ends done."""
    client, job, clock, model = _job(monkeypatch, pieces)
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
            _person_edits(client, 'd1', [{'words': ['ka', 'ta'], 'translation': ('One.', 'human')},
                                         {'words': [MINE['sa']], 'translation': ('Two.', 'human')}], 3,
                          {'t': clock['t'] - 700})
        slept(s)
    job._sleep = sleep
    staged = _staged(monkeypatch)
    runner(job).work(job)
    assert lost['n'] == 2, 'the 502 was met'
    assert _analysed(staged) == ['d1-s1w1', 'd1-s1w2', 'd1-s2w1'], 'each word written once'
    assert len([c for c in model.calls if c['n'] == 1]) == 1, 'the model is not asked again'
    assert _skipped(job) == [('d1-s1', 'interrupted')]
    assert job.rows['d1']['state'] == 'done'


# --- a write put off halfway --------------------------------------------------------------

def _sani(gloss):
    morphs = [('sa', 'go')] + ([('ni', gloss)] if gloss else [('ni', None)])
    return ('sani', morphs, J)


@pytest.mark.parametrize('pieces', PIECES)
def test_a_write_put_off_after_its_first_batch_landed_puts_nothing_back(monkeypatch, pieces):
    """A write of two batches: s1's lands, s2's is refused, the starter
    having typed in s3. When the document comes back the starter has
    cleared the job's gloss on s1.w2: nothing in s1 or s2 is written again,
    s2 is listed as interrupted, and s1 is not vouched for."""
    human = {'form': 'ka', 'morphs': [('ka', 'go')], 'who': 'human'}
    typed = {'form': 'ka', 'morphs': [('ka', 'went')], 'who': 'human'}
    blank = [{'words': ['sani', 'sani']}, {'words': ['sani', 'sani']}, {'words': [human]}]
    refs = {'s1.w1': 'sani', 's1.w2': 'sani', 's2.w1': 'sani', 's2.w2': 'sani'}

    def model(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        return reply(calls=[call(i, 'set_analysis', {'document': 'Story', 'ref': ref, 'morphemes': [
            {'form': 'sa', 'fields': {'Morph Gloss': 'go'}}, {'form': 'ni', 'fields': {'Morph Gloss': 'now'}}]})
            for i, ref in enumerate(refs, start=1)])
    client, job, clock, _ = _job(monkeypatch, pieces, before=blank, after=blank, model=model)
    from plaid_agent.core import plan
    budget = plan.TrackingBatcher.__init__.__defaults__
    monkeypatch.setattr(plan.TrackingBatcher.__init__, '__defaults__', (2,) + budget[1:])
    from plaid_client import testing
    real, n = testing._Batch.submit, {'n': 0}

    def submit(self):
        n['n'] += 1
        if n['n'] == 2:
            done = [{'words': [_sani('now'), _sani('now')]}, {'words': ['sani', 'sani']}, {'words': [typed]}]
            _person_edits(client, 'd1', done, 3, {'t': clock['t'] - 700})
            raise PlaidAPIError('HTTP 409 version', status=409)
        if n['n'] == 3:
            # Back later: the person cleared the gloss of -ni on s1.w2.
            cleared = [{'words': [_sani('now'), _sani(None)]}, {'words': ['sani', 'sani']}, {'words': [typed]}]
            _person_edits(client, 'd1', cleared, 4, {'t': clock['t'] - 700})
        return real(self)
    monkeypatch.setattr(testing._Batch, 'submit', submit)

    def wait(s):
        clock['t'] += s
        if n['n'] == 2:
            cleared = [{'words': [_sani('now'), _sani(None)]}, {'words': ['sani', 'sani']}, {'words': [typed]}]
            _person_edits(client, 'd1', cleared, 4, {'t': clock['t'] - 700})
            n['n'] = 99
    job._sleep = wait
    staged = _staged(monkeypatch)
    runner(job).work(job)
    assert n['n'] >= 2, 'the second batch was refused'
    written = [o.get('word_id') for o in staged if o.get('kind') == 'set_analysis']
    assert written.count('d1-s1w2') == 1 and written.count('d1-s2w1') == 1, \
        f'nothing of s1 or s2 is written again: {written}'
    assert ('d1-s2', 'interrupted') in _skipped(job)
    assert not _mark(client, 'd1-s1').get('words'), 's1 is not vouched for'
    assert job.rows['d1']['state'] == 'done'


# --- a person editing during the piece ----------------------------------------------------

@pytest.mark.parametrize('pieces', PIECES)
def test_a_sentence_a_person_edits_during_the_piece_is_taken_again(monkeypatch, pieces):
    """REV-JG-5: a person edits s1's translation while the model works. The
    piece's ops in s1 are not written over the person's edit: s1 is taken
    again by a piece of its own, and glossed then. s2 is written at once."""
    client, job, clock, _ = _job(monkeypatch, pieces, after=BLANK)
    edited = [{'words': ['ka', 'ta'], 'translation': ('One, edited.', 'human')},
              {'words': ['sa'], 'translation': ('Two.', 'human')}]
    once = {'n': 0}

    def model(asked, n, kwargs):
        if n > 1:
            if not once['n']:
                once['n'] = 1
                client._holder('d1')['documents']['d1'] = document('d1', 'Story', edited, version=5)
                client.after_write['d1'] = document('d1', 'Story', edited, version=5)
            return reply('Glossed.')
        return _gloss()(asked, n, kwargs)
    use(monkeypatch, Model(model))
    staged = _staged(monkeypatch)
    runner(job).work(job)
    written = [o.get('word_id') for o in staged if o.get('kind') == 'set_analysis']
    assert written.count('d1-s2w1') == 1, written
    assert 'd1-s1w1' in written and 'd1-s1w2' in written, f's1 is taken again: {written}'
    assert not _skipped(job)
    assert job.rows['d1']['state'] == 'done'


@pytest.mark.parametrize('pieces', PIECES)
def test_a_sentence_a_person_edits_during_each_piece_is_listed_skipped_as_changed(monkeypatch, pieces):
    """The same, the person editing s1 again while it is taken again: s1 is
    skipped and listed "Changed during the job", never written and never
    silent."""
    client, job, clock, _ = _job(monkeypatch, pieces, after=BLANK)
    version = {'v': 4}

    def model(asked, n, kwargs):
        if n > 1:
            version['v'] += 1
            edited = [{'words': ['ka', 'ta'], 'translation': (f'One, edit {version["v"]}.', 'human')},
                      {'words': ['sa'], 'translation': ('Two.', 'human')}]
            client._holder('d1')['documents']['d1'] = document('d1', 'Story', edited, version=version['v'])
            client.after_write['d1'] = document('d1', 'Story', edited, version=version['v'])
            return reply('Glossed.')
        return _gloss()(asked, n, kwargs)
    use(monkeypatch, Model(model))
    staged = _staged(monkeypatch)
    runner(job).work(job)
    written = [o.get('word_id') for o in staged if o.get('kind') == 'set_analysis']
    assert 'd1-s1w1' not in written and 'd1-s1w2' not in written, written
    assert ('d1-s1', 'changed') in _skipped(job)
    assert job.rows['d1']['state'] == 'done'


# --- a split or a merge after the job wrote ----------------------------------------------

THREE = [{'words': ['ka', 'ta', 'pa'], 'translation': ('One.', 'human')},
         {'words': ['sa'], 'translation': ('Two.', 'human')}]
THREE_WRITTEN = [{'words': [MINE['ka'], MINE['ta'], MINE['pa']], 'translation': ('One.', 'human')},
                 {'words': [MINE['sa']], 'translation': ('Two.', 'human')}]
THREE_REFS = {'s1.w1': 'ka', 's1.w2': 'ta', 's1.w3': 'pa', 's2.w1': 'sa'}


def _reshaped_then_resumed(monkeypatch, pieces, after, ids, refs):
    client, job, clock, _ = _job(monkeypatch, pieces, before=THREE, after=THREE_WRITTEN, model=_gloss(THREE_REFS))
    _crash_at_record(monkeypatch, job)
    clock['t'] += 3600
    raw = reshaped(document('d1', 'Story', after, version=3), ids)
    client.after_write['d1'] = raw
    client._holder('d1')['documents']['d1'] = raw
    history = client._holder('d1')['audit']
    history.append({'id': f'person-{len(history)}', 'time': _iso(clock['t'] - 700), 'ref': None,
                    'documents': [{'id': 'd1'}], 'ops': []})
    use(monkeypatch, Model(_gloss(refs)))
    staged = _staged(monkeypatch)
    _resume(client, job).work(job)
    return client, job, staged


@pytest.mark.parametrize('pieces', PIECES)
def test_a_split_after_the_write_and_a_cleared_proposal_is_never_glossed_again(monkeypatch, pieces):
    """The starter splits s1 before pa (the right half gets a new id) and
    clears the job's proposal on pa. The half holds a word the job wrote in:
    nothing is written in it."""
    _, job, staged = _reshaped_then_resumed(
        monkeypatch, pieces,
        [{'words': [MINE['ka'], MINE['ta']], 'translation': ('One.', 'human')}, {'words': ['pa']},
         {'words': [MINE['sa']], 'translation': ('Two.', 'human')}],
        {'d1-s2w1': 'd1-s1w3', 'd1-s2': 'd1-sNEW', 'd1-s3w1': 'd1-s2w1', 'd1-s3': 'd1-s2'},
        {'s2.w1': 'pa'})
    assert _analysed(staged) == [], 'pa is not glossed again'
    assert job.rows['d1']['state'] == 'done'


@pytest.mark.parametrize('pieces', PIECES)
def test_a_merge_after_the_write_and_a_cleared_proposal_is_never_glossed_again(monkeypatch, pieces):
    """The starter merges s1 into s2 (s2's id survives) and clears the job's
    proposal on pa. The survivor holds words the job wrote in: nothing is
    written in it."""
    _, job, staged = _reshaped_then_resumed(
        monkeypatch, pieces,
        [{'words': [MINE['ka'], MINE['ta'], 'pa', MINE['sa']], 'translation': ('One. Two.', 'human')}],
        {'d1-s1': 'd1-s2', 'd1-s1w1': 'd1-s1w1', 'd1-s1w4': 'd1-s2w1'},
        {'s1.w3': 'pa'})
    assert _analysed(staged) == [], 'pa is not glossed again'
    assert job.rows['d1']['state'] == 'done'


# --- harmonize goes through the gate --------------------------------------------------------

def test_harmonize_settles_a_document_before_it_rewrites_in_it(monkeypatch):
    """Harmonize writes in a document only after the gate: a document whose
    write's record was lost is settled first."""
    client, job, clock, _ = _job(monkeypatch, 'sentences')
    _crash_at_record(monkeypatch, job)
    r = _resume(client, job)
    asked = []
    real = r.gate

    def gate(project, document_id, client=None):
        asked.append((document_id, r.unsettled(document_id)))
        return real(project, document_id, client)
    monkeypatch.setattr(r, 'gate', gate)
    r.harmonize(job)
    assert asked and asked[0] == ('d1', True), asked
    assert _mark(client, 'd1-s1')['counts']['words'] == 2


# --- core out of reach during the write ------------------------------------------------------

@pytest.mark.parametrize('pieces', PIECES)
def test_core_out_of_reach_during_a_write_puts_the_document_off_and_the_job_ends_done(monkeypatch, pieces):
    """REV-JG-4: core answers 502 to every write. The document is put off as
    a stretch's is, waited for, and ended in use: the job ends done, never
    failed with the error."""
    client, job, clock, _ = _job(monkeypatch, pieces)

    def down(c, ops, **kw):
        raise PlaidAPIError('HTTP 502', status=502, method='POST')
    monkeypatch.setattr(igt_job, 'execute_plan', down)
    from plaid_agent.core.job import run_job
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished['state'], finished.get('reason'), job.status.get('message'))
    assert finished['report']['documents'][0]['state'] == 'in-use'


@pytest.mark.parametrize('pieces', PIECES)
def test_core_back_after_a_put_off_write_writes_the_document(monkeypatch, pieces):
    """The same, core back after the first put-off: the document is written
    when it comes back, and the job ends done."""
    client, job, clock, _ = _job(monkeypatch, pieces, after=WRITTEN)
    real = igt_job.execute_plan
    fails = {'n': 3}

    def flaky(c, ops, **kw):
        if fails['n']:
            fails['n'] -= 1
            raise PlaidAPIError('HTTP 502', status=502, method='POST')
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', flaky)
    from plaid_agent.core.job import run_job
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished['state'], finished.get('reason'), job.status.get('message'))
    assert finished['report']['documents'][0]['state'] == 'done'
    assert finished['report']['totals']['words'] == 3


def test_what_a_piece_stages_in_a_sentence_skipped_as_too_long_meets_the_rule_whatever_the_piece(monkeypatch):
    """A sentence too long for a stretch is skipped at the checks. What a
    document piece or a selection stages there goes to the apply rule all
    the same, never dropped by one and not the other."""
    written = {}
    for pieces in ('document', 'selection'):
        monkeypatch.setattr(igt_job, 'JOB_SENTENCE_MAX_WORDS', 1)
        client, job, clock, _ = _job(monkeypatch, pieces)
        staged = _staged(monkeypatch)
        from plaid_agent.core.job import run_job
        finished = run_job(job, runner(job))
        assert ('d1-s1', 'too-long') in _skipped(job), pieces
        written[pieces] = (_analysed(staged), finished['report']['totals']['proposed'])
    assert written['document'] == written['selection'], written
