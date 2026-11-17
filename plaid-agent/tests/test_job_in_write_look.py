"""The look inside THE write (REV-HFA-1, -2, -3, -4, -5, -6): under the
document's lock, just before a piece's write is sent, the job asks whether
anyone else wrote in the document after the piece's mark (core's stamp of the
newest History unit at the look before the piece read it), and puts the
document off when someone did. So no path writes over a value a person typed
while the piece worked: a whole-selection piece, the halves of a failed
stretch, the piece after a text edit. The reviewer's two probes are the
first two tests."""

from datetime import datetime, timezone

from job_fixtures import JobClient, Model, call, document, reply, runner, start, targets_named, use

from fixtures import MGLOSS
from plaid_agent.core.job import StretchFailed, run_job
from plaid_agent.igt import job as igt_job


def _iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat().replace('+00:00', 'Z')


def _doc(doc_id, name, n):
    return document(doc_id, name, [{'words': [('nidr', [('nidr', 'be')], 'human')]} for _ in range(n)])


def _person(client, job, doc_id, sentence, value, ref=None):
    """A person sets s<sentence>.w1.m1's gloss to ``value``: the stored
    document changes and History gets a unit by someone else, now."""
    raw = client._holder(doc_id)['documents'][doc_id]
    for tl in raw['text_layers'][0]['token_layers']:
        for sl in tl['span_layers']:
            if sl['id'] == MGLOSS:
                for sp in sl['spans']:
                    if sp['tokens'] == [f'{doc_id}-s{sentence}w1m1']:
                        sp['value'] = value
    raw['version'] = raw['version'] + 1
    audit = client._holder(doc_id)['audit']
    audit.append({'id': f'person-{len(audit)}', 'time': _iso(job.now()), 'ref': ref, 'kind': None,
                  'documents': [{'id': doc_id}], 'ops': []})


def _spy(monkeypatch, events):
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        for o in ops:
            events.append(('write', repr(o)))
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    real_defer = igt_job.IgtRunner.defer

    def defer(self, d):
        events.append(('defer', d))
        return real_defer(self, d)
    monkeypatch.setattr(igt_job.IgtRunner, 'defer', defer)


def _first_overwrite(events, token):
    for i, (k, v) in enumerate(events):
        if k == 'write' and token in v and 'JOB' in v:
            return i
    return None


def _defers(events, d):
    return [i for i, (k, v) in enumerate(events) if k == 'defer' and v == d]


def _job(client, **kw):
    job = start(client, 'Gloss every word JOB.', fills=(MGLOSS,), **kw)
    job.job['created_at'] = _iso(job.now() - 3600)
    return job


def _glossing(doc_of=None):
    def answer(asked, n, kwargs):
        if n > 1:
            return reply('Done.')
        doc = asked.split('"')[1]
        return reply(calls=[call(k, 'set_field', {'document': doc, 'refs': [f's{s}.w1.m1'],
                                                  'field': 'Morph Gloss', 'value': 'JOB'})
                            for k, s in enumerate(targets_named(asked), start=1)])
    return answer


def test_a_halved_stretch_puts_the_document_off_before_writing_over_a_person(monkeypatch):
    """REV-HFA-2: a person types in s4 while the stretch s1 to s5 runs, its
    model fails, and the stretch is halved. Neither half writes over s4: the
    document is put off first."""
    client = JobClient({'d1': _doc('d1', 'Story 1', 5), 'd2': _doc('d2', 'Story 2', 1)})
    job = _job(client)
    events = []
    _spy(monkeypatch, events)
    typed = {'done': False}
    gloss = _glossing()

    def answer(asked, n, kwargs):
        if len(targets_named(asked)) == 5:
            if not typed['done']:
                typed['done'] = True
                _person(client, job, 'd1', 4, 'PERSON')
            raise StretchFailed('output', 'too long')
        return gloss(asked, n, kwargs)
    use(monkeypatch, Model(answer))
    run_job(job, runner(job))
    at = _first_overwrite(events, 'd1-s4w1m1')
    defers = _defers(events, 'd1')
    assert at is None or (defers and defers[0] < at), f'PERSON overwritten at {at}, defers {defers}'
    assert defers, 'Story 1 was put off'


def test_a_selection_piece_puts_off_a_document_a_person_typed_in_while_it_ran(monkeypatch):
    """REV-HFA-1: a person types in Story 1 while the whole-selection piece
    runs, before its tools load the document. The piece's write there is put
    off, never sent over the person's value."""
    client = JobClient({'d1': _doc('d1', 'Story 1', 2), 'd2': _doc('d2', 'Story 2', 1)})
    job = _job(client, plan='selection')
    events = []
    _spy(monkeypatch, events)
    typed = {'done': False}

    def answer(asked, n, kwargs):
        if n == 1:
            if not typed['done']:
                typed['done'] = True
                _person(client, job, 'd1', 1, 'PERSON')
            return reply(calls=[call(1, 'set_field', {'document': 'Story 1', 'refs': ['s1.w1.m1'],
                                                      'field': 'Morph Gloss', 'value': 'JOB'})])
        return reply('Done.')
    use(monkeypatch, Model(answer))
    run_job(job, runner(job))
    at = _first_overwrite(events, 'd1-s1w1m1')
    defers = _defers(events, 'd1')
    assert at is None or (defers and defers[0] < at), f'PERSON overwritten at {at}, defers {defers}'
    assert defers, 'Story 1 was put off'


def test_a_document_a_stopped_worker_was_working_in_is_marked_at_the_jobs_making(monkeypatch):
    """REV-HFA-6: after a restart mid-stretch, the edits of the stretch
    in flight are not known. The first look in such a document marks the
    job's making, so the write is put off when anyone wrote during the job,
    however long ago: in doubt, never written."""
    client = JobClient({'d1': _doc('d1', 'Story 1', 1)})
    job = _job(client)
    r = runner(job)
    _person(client, job, 'd1', 1, 'PERSON')
    job.now = (lambda base: (lambda: base + 3000))(job.now())
    r.in_flight = {'d1'}
    assert not r.in_use(r.newest_change(client, 'd1'), r.own_ref), 'quiet by the window'
    assert r.someone_since_mark(client, 'd1'), 'yet written during the job, before the restart'
    assert 'd1' not in r.in_flight, 'only its first look'


def test_every_look_marks_and_the_write_asks_against_that_mark(monkeypatch):
    """REV-HFA-7: every look (the walk's, the piece after a text edit's,
    harmonize's) is :meth:`newest_change`, which marks: a person typing after
    it, while the piece reads and works, puts its write off."""
    client = JobClient({'d1': _doc('d1', 'Story 1', 1)})
    job = _job(client)
    r = runner(job)
    assert not r.in_use(r.newest_change(client, 'd1'), r.own_ref)
    mark = r.seen_marks['d1']
    _person(client, job, 'd1', 1, 'PERSON')
    assert r.seen_marks['d1'] == mark and r.someone_since_mark(client, 'd1')


def test_a_persons_undo_of_the_jobs_entry_is_someone_in_the_document(monkeypatch):
    """REV-HFA-3: core gives a whole Undo of the job's entry the ref
    ``job:<id>/undo``. Only ``job:<id>/doc:`` is the job's own."""
    client = JobClient({'d1': _doc('d1', 'Story 1', 1)})
    job = _job(client)
    r = runner(job)
    _person(client, job, 'd1', 1, 'nidr-be', ref=f'job:{job.id}/undo')
    assert r.in_use(r.newest_change(client, 'd1'), r.own_ref)


