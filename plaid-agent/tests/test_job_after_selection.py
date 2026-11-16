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
    # REV-RPF3B-1: the step wrote in 24 of them, so it never says it did not
    # open them.
    assert report['notice'].endswith("45 documents were not read through by the job's first step, which worked on "
                                     'the whole selection.'), report['notice']


def test_the_top_line_is_true_of_a_document_the_first_step_read_in_part(monkeypatch):
    """REV-RPF3B-1 (the reviewer's r2b): a check whose first step read s1
    of each of two documents of three sentences. Neither was read through,
    and the top line never says the step did not open them."""
    three = [{'words': [('nidr', [('nidr', 'be')], 'human')]} for _ in range(3)]
    client = JobClient({'d1': document('d1', 'Story 1', three), 'd2': document('d2', 'Story 2', three)})
    job = start(client, 'List the glosses in small capitals. Change nothing.', id=J, plan='selection', fills=())

    def answer(asked, k, kwargs):
        if k == 1:
            return reply(calls=[call(i, 'read_document', {'document': f'Story {i}', 'from_sentence': 1,
                                                          'to_sentence': 1}) for i in (1, 2)])
        return reply('None.')
    use(monkeypatch, Model(answer))
    report = run_job(job, runner(job))['report']
    assert report['notice'] == ("2 documents were not read through by the job's first step, which worked on the "
                                'whole selection.'), report['notice']


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


def test_a_check_walks_nothing_after_its_selection_whatever_it_read(monkeypatch):
    """One rule for every plan (RPF3 round 3, REV-RPF3-9): a plan that fills
    nothing never walks a document after its selection piece. Stories 2 and 3,
    never read, end done and not read through, and the report's top line says
    so."""
    client = JobClient({f'd{i}': _doc(i, OLD if i == 1 else 'be') for i in (1, 2, 3)})
    job = start(client, 'List the glosses in small capitals. Change nothing.', id=J, plan='selection', fills=())

    def answer(asked, k, kwargs):
        if k == 1:
            return reply(calls=[call(1, 'read_document', {'document': 'Story 1'})])
        return reply(f'One: {OLD}.')
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert len(_pieces(model)) == 1
    report = finished['report']
    assert report['plan']['fallback'] == []
    docs = {d['name']: d for d in report['documents']}
    assert igt_job.NOT_WALKED not in docs['Story 1']['counts']
    assert all(docs[n]['counts'].get(igt_job.NOT_WALKED) is True for n in ('Story 2', 'Story 3'))
    assert report['notice'] == ("2 documents were not read through by the job's first step, which worked on the "
                                'whole selection.')


def test_a_check_whose_selection_read_every_document_ends_after_it(monkeypatch):
    """RP2-3's shape: one piece that read every document. Nothing is walked."""
    client = JobClient({'d1': _doc(1, OLD), 'd2': document('d2', 'Story 2', [{'words': ['sa']}])})
    job = start(client, 'List the glosses in small capitals. Change nothing.', id=J, plan='selection', fills=())

    def answer(asked, k, kwargs):
        if k == 1:
            return reply(calls=[call(1, 'read_document', {'document': 'Story 1'}),
                                call(2, 'read_document', {'document': 'Story 2'})])
        return reply(f'One: {OLD} in Story 1.')
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert len(_pieces(model)) == 1
    assert [d['state'] for d in finished['report']['documents']] == ['done', 'done']
    assert finished['report']['plan']['fallback'] == []


def _sentences(n, blank_at=None):
    return [{'words': [('nidr', [('nidr', 'be')], 'human'),
                       'sa' if i == blank_at else ('ka', [('ka', 'go')], 'human')]} for i in range(1, n + 1)]


def test_a_never_read_document_with_one_empty_is_walked_only_where_it_is_empty(monkeypatch):
    """REV-RPF3-2 (the reviewer's a1): the rename's shape, Story 3 of 20
    sentences, never read, holds one unglossed word in s10. Its walk takes s10
    alone: one stretch, one model call."""
    client = JobClient({'d1': _doc(1, OLD), 'd2': _doc(2, OLD),
                        'd3': document('d3', 'Story 3', _sentences(20, blank_at=10))})
    _applying(monkeypatch, client)
    job = start(client, f'Change the gloss {OLD} to {NEW} everywhere.', id=J, plan='selection', fills=(MGLOSS,))

    def answer(asked, k, kwargs):
        if 'Your piece: the whole selection above.' not in asked:
            return reply('Nothing to do here.')
        if k == 1:
            return reply(calls=[call(i, 'set_field', {'document': f'Story {i}', 'refs': ['s1.w1.m1'],
                                                      'field': 'Morph Gloss', 'value': NEW}) for i in (1, 2)])
        return reply('Renamed.')
    model = use(monkeypatch, Model(answer))
    run_job(job, runner(job))
    walked = _pieces(model)[1:]
    assert len(walked) == 1 and walked[0].rstrip().endswith('Your piece: s10. s8, s9 are context.'), walked


def test_the_piece_after_a_selections_text_edit_runs_before_the_walk_is_decided(monkeypatch):
    """REV-RPF3-3 (the reviewer's a3): onlynew, a selection whose piece reads
    s1 of a 12-sentence Story 1 and inserts xosan there. The piece after the
    text edit glosses xosan before the documents not read through are
    decided: nothing is empty after it, so nothing is walked."""
    from job_fixtures import text_edits
    text_edits(monkeypatch)
    sents = _sentences(12)
    client = JobClient({'d1': document('d1', 'Story 1', sents), 'd2': _doc(2, 'be')})
    after = [{'words': [('nidr', [('nidr', 'be')], 'human'), 'xosan', ('ka', [('ka', 'go')], 'human')]}] + sents[1:]
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        if any(o['kind'] == 'edit_text' for o in ops):
            raw = document('d1', 'Story 1', after, version=5)
            words = raw['text_layers'][0]['token_layers'][1]['tokens']
            words[1]['id'], words[2]['id'] = 'd1-new', 'd1-s1w2'
            for m in raw['text_layers'][0]['token_layers'][2]['tokens']:
                m['id'] = m['id'].replace('d1-s1w3', 'd1-s1w2')
            client._holder('d1')['documents']['d1'] = raw
            return {}
        if any(o['kind'] == 'set_analysis' for o in ops):
            raw = document('d1', 'Story 1', [{'words': [('nidr', [('nidr', 'be')], 'human'),
                                                        ('xosan', [('xosan', 'good')], J),
                                                        ('ka', [('ka', 'go')], 'human')]}] + sents[1:], version=6)
            words = raw['text_layers'][0]['token_layers'][1]['tokens']
            words[1]['id'], words[2]['id'] = 'd1-new', 'd1-s1w2'
            for m in raw['text_layers'][0]['token_layers'][2]['tokens']:
                m['id'] = m['id'].replace('d1-s1w2m', 'd1-newm').replace('d1-s1w3', 'd1-s1w2')
            client._holder('d1')['documents']['d1'] = raw
            return {}
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    setup = {'fills': [{'id': 'segmentation', 'name': 'segmentation'}, {'id': MGLOSS, 'name': 'Morph Gloss'}],
             'text': True, 'conversation': 'c1', 'onlynew': True}
    job = start(client, 'Insert xosan after nidr in Story 1 s1 and gloss it.', id=J, plan='selection',
                fills=('segmentation', MGLOSS), setup=setup)
    kinds = []

    def answer(asked, k, kwargs):
        if 'Instructions from' not in asked:
            return reply('Done.')
        kind = ('sel' if 'Your piece: the whole selection above.' in asked
                else 'after' if igt_job.AFTER_TEXT_LINE in asked else 'walk')
        if k == 1:
            kinds.append(kind)
        if kind == 'sel':
            if k == 1:
                return reply(calls=[call(1, 'read_sentences', {'document': 'Story 1', 'refs': ['s1']}),
                                    call(2, 'retype_sentence', {'document': 'Story 1', 'ref': 's1',
                                                                'text': 'nidr xosan ka.'})])
            return reply('Inserted.')
        if kind == 'after' and k == 1:
            return reply(calls=[call(9, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w2 "xosan"', 'morphemes': [
                {'form': 'xosan', 'fields': {'Morph Gloss': 'good'}}]})])
        return reply('Nothing.')
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert kinds == ['sel', 'after'], kinds
    assert finished['report']['plan']['fallback'] == []
