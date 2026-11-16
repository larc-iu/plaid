"""After a selection's piece, a document it did not read through is walked
only when it still holds something the plan fills that is empty (RPF3-A).

RP2-4: a rename of one gloss across 45 documents wrote all 33 changes in the
selection's piece within minutes, then the walk worked every sentence of all
45 documents, a model call per stretch, "Nothing written" each time, about 8
hours. The rule now, fixed and by the plan's targets only (the one "empty"
rule of igt/targets.py): such a document is worked as pieces of its own only
if a sentence the walk would take holds a unit empty of what the plan fills.
Otherwise it ends done with no model call, its row's ``counts.not_walked``
true and its counts those of what the piece wrote there. A plan that fills
nothing never walks one."""

from job_fixtures import JobClient, Model, call, document, reply, runner, start, use

from fixtures import MGLOSS
from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job

J = 'JAS'
OLD, NEW = 'be.3ᴀᴜɢII', 'be.3AUGII'


def _doc(i, gloss):
    """Story i: one sentence, nidr glossed ``gloss`` and ka glossed go, both
    a person's."""
    return document(f'd{i}', f'Story {i}', [{'words': [('nidr', [('nidr', gloss)], 'human'),
                                                       ('ka', [('ka', 'go')], 'human')]}])


def _renamed(i):
    """Story i with nidr's gloss renamed by the job."""
    return document(f'd{i}', f'Story {i}', [{'words': [('nidr', [('nidr', NEW)], {'token': 'human', 'span': J,
                                                                                    'link': 'human'}),
                                                       ('ka', [('ka', 'go')], 'human')]}], version=2)


def _applying(monkeypatch, client):
    """Each write leaves its document renamed for the reads after it."""
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        out = real(c, ops, **kw)
        for o in ops:
            for v in o.values():
                if isinstance(v, str) and v.startswith('sp-d'):
                    i = int(v[len('sp-d'):].split('-')[0])
                    client.after_write[f'd{i}'] = _renamed(i)
        return out
    monkeypatch.setattr(igt_job, 'execute_plan', execute)


def _pieces(model):
    return [c['asked'] for c in model.calls if c['n'] == 1]


def test_a_rename_by_a_project_wide_step_walks_no_document_after_it(monkeypatch):
    """The rename's shape: 45 documents, every gloss filled, nidr glossed
    OLD in 24 of them. The selection's piece renames each by reference,
    reading no document. No model call follows it, every document ends done,
    not read through, and each document's changes are what it wrote there."""
    n, renamed = 45, set(range(1, 25))
    client = JobClient({f'd{i}': _doc(i, OLD if i in renamed else 'be') for i in range(1, n + 1)})
    _applying(monkeypatch, client)
    job = start(client, f'Change the gloss {OLD} to {NEW} everywhere.', id=J, plan='selection', fills=(MGLOSS,))

    def answer(asked, k, kwargs):
        if 'Your piece: the whole selection above.' not in asked:
            return reply('Nothing to do here.')
        if k == 1:
            return reply(calls=[call(i, 'set_field', {'document': f'Story {i}', 'refs': ['s1.w1.m1'],
                                                      'field': 'Morph Gloss', 'value': NEW}) for i in sorted(renamed)])
        return reply(f'Renamed {OLD} to {NEW} in 24 documents.')
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert len(_pieces(model)) == 1, 'the selection, and no piece after it'
    report = finished['report']
    assert report['plan']['fallback'] == [], 'no document walked'
    docs = {d['name']: d for d in report['documents']}
    assert all(d['state'] == 'done' and d['counts'].get(igt_job.NOT_WALKED) is True for d in docs.values()), \
        [(d['name'], d['state'], d['counts'].get(igt_job.NOT_WALKED)) for d in docs.values()]
    assert {name for name, d in docs.items() if d['counts']['changes']} == {f'Story {i}' for i in renamed}
    assert all(docs[f'Story {i}']['counts']['changes'] == 1 for i in renamed)
    assert report['totals']['changes'] == 24
    assert report['totals']['documents_done'] == n
    # Nothing is said to be left blank in a document nothing is empty in.
    assert not any(d.get('left') for d in docs.values())


def test_a_fill_by_selection_still_walks_a_document_it_never_read_that_holds_an_empty(monkeypatch):
    """The selection glosses nidr in Story 1 by reference. Story 2, never
    read, holds an unglossed word: it is walked as a piece of its own, the
    plan says so, and the heartbeat's line counts it among those the first
    step did not read. Story 3, never read and full, is not walked."""
    client = JobClient({'d1': _doc(1, OLD),
                        'd2': document('d2', 'Story 2', [{'words': [('nidr', [('nidr', 'be')], 'human'), 'sa']}]),
                        'd3': _doc(3, 'be')})
    _applying(monkeypatch, client)
    job = start(client, 'Gloss what is unglossed.', id=J, plan='selection', fills=('segmentation', MGLOSS))
    lines = []

    def answer(asked, k, kwargs):
        if 'Your piece: the whole selection above.' in asked:
            if k == 1:
                return reply(calls=[call(1, 'set_field', {'document': 'Story 1', 'refs': ['s1.w1.m1'],
                                                          'field': 'Morph Gloss', 'value': NEW})])
            return reply('Ran out of time.')
        if k == 1:
            lines.append(job.status.get('message'))
        return reply('Done.')
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    walked = [a for a in _pieces(model) if 'Your piece: the whole selection above.' not in a]
    assert len(walked) == 1 and '"Story 2"' in walked[0], walked
    assert lines == ['Checking 1 document the first step did not read. Story 2: sentences 1 to 1 of 1.'], lines
    report = finished['report']
    assert [(f['document_id'], f['reason']) for f in report['plan']['fallback']] == [('d2', 'not-read')]
    docs = {d['name']: d for d in report['documents']}
    assert docs['Story 1']['counts'].get(igt_job.NOT_WALKED) is True
    assert docs['Story 3']['counts'].get(igt_job.NOT_WALKED) is True
    assert igt_job.NOT_WALKED not in docs['Story 2']['counts']


def test_a_report_only_selection_walks_nothing_and_says_what_it_did_not_read(monkeypatch):
    """A job that fills nothing: one model call, every document done, those
    its piece did not read through said so."""
    client = JobClient({'d1': _doc(1, OLD), 'd2': document('d2', 'Story 2', [{'words': ['sa']}])})
    job = start(client, 'List the glosses in small capitals. Change nothing.', id=J, plan='selection', fills=())

    def answer(asked, k, kwargs):
        if k == 1:
            return reply(calls=[call(1, 'read_document', {'document': 'Story 1'})])
        return reply(f'One: {OLD} in Story 1.')
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert len(_pieces(model)) == 1
    docs = {d['name']: d for d in finished['report']['documents']}
    assert [d['state'] for d in docs.values()] == ['done', 'done']
    assert igt_job.NOT_WALKED not in docs['Story 1']['counts']
    assert docs['Story 2']['counts'].get(igt_job.NOT_WALKED) is True
