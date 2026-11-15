"""What the job page shows of a running job (BRIEF LV): one summary row per
piece of its work among its decisions (``PIECE_FORM``), and first the plan's,
each kept once what the piece wrote is known, read by any reader newest first
(``jobs.pieces``). What a summary says the piece wrote is what LANDED of its
own writes, never what a try meant to write, and no piece is summed up twice,
after a lost answer or a crash. And the heartbeat's line counts the model
steps (tool calls, as the chat counts them) of the piece in hand, or of the
planning, never sending a heartbeat of
its own."""

import json

import pytest

from job_fixtures import JobClient, Model, call, document, reply, runner, start, targets_named, use

from plaid_agent.core.job import run_job
from plaid_agent.igt import job as igt_job
from plaid_agent.igt.job import PIECE_FORM

import test_job_tries as tries

J = 'JA'
N = 4


def _doc(analysed=frozenset(), version=1):
    return document('d1', 'Story', [{'words': [(w, [(w, 'g')], J) if f'd1-s{i}w{k}' in analysed else w
                                               for k, w in enumerate([f'ka{i}', f'ta{i}'], start=1)]}
                                    for i in range(1, N + 1)], version=version)


def _applying(monkeypatch, client):
    analysed, real = set(), igt_job.execute_plan

    def execute(c, ops, **kw):
        out = real(c, ops, **kw)
        analysed.update(o['word_id'] for o in ops if o.get('kind') == 'set_analysis')
        client.after_write['d1'] = _doc(analysed, version=len(client.writes) + 1)
        return out
    monkeypatch.setattr(igt_job, 'execute_plan', execute)


def _gloss(asked, n, kwargs=None):
    """Glosses both words of every sentence of its piece, in one call, then says so."""
    if n > 1:
        return reply(f'Glossed {asked.count("Your piece")} piece.')
    mine = targets_named(asked)
    return reply(calls=[call(10 * s + w, 'set_analysis', {'document': 'Story', 'ref': f's{s}.w{w}', 'morphemes': [
        {'form': 'x', 'fields': {'Morph Gloss': 'g'}}]}) for s in mine for w in (1, 2)]
        + [call(100 + s, 'set_field', {'document': 'Story', 'refs': [f's{s}.w1'], 'field': 'Gloss', 'value': 'G'})
           for s in mine])


def _pieces(client):
    """The summaries as the page reads them, newest first."""
    return client.jobs.pieces(J)


def _run(monkeypatch, answer, plan='sentences', stretch=2):
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', stretch)
    client = JobClient({'d1': _doc()})
    job = start(client, id=J, plan=plan)
    _applying(monkeypatch, client)
    use(monkeypatch, Model(answer))
    return client, job, run_job(job, runner(job))


def test_each_piece_is_summed_up_once_its_write_landed_newest_first(monkeypatch):
    client, job, finished = _run(monkeypatch, _gloss)
    assert finished['state'] == 'done'
    rows = _pieces(client)
    assert [r['seq'] for r in rows] == ['000002', '000001'], 'newest first, numbered from 1 after the plan'
    second, first = (r['piece'] for r in rows)
    assert (first['first'], first['last'], first['first_id']) == ('s1', 's2', 'd1-s1')
    assert (second['first'], second['last'], second['first_id']) == ('s3', 's4', 'd1-s3')
    for p in (first, second):
        assert p['document'] == 'd1' and p['name'] == 'Story' and p['whole'] is False
        assert p['note'] == 'Glossed 1 piece.', 'the note as the model ended it'
        assert p['steps'] == 6, 'each tool call a step, as the chat counts them'
        assert p['counts'] == {'analyzed': 2, 'words': 4, 'changes': 6}, p['counts']
        assert [(f['field'], f['values'], f.get('outside')) for f in p['fields']] == [('Gloss', 2, None)], p['fields']
        assert p['ended_at'].endswith('Z')
        assert 'skipped' not in p and 'refused' not in p
    # The pieces' sums are the document's.
    assert sum(r['piece']['counts']['words'] for r in rows) == job.rows['d1']['counts']['words']
    # The row as core keeps it: its keys in kebab case, as a report goes out.
    stored = client.jobs.decision_rows[J][(PIECE_FORM, '000001')]
    assert '"first-id":"d1-s1"' in stored['analysis'] and stored['first_document'] == 'd1'
    assert stored['first_sentence'] == 'd1-s1'


def test_a_piece_that_answered_nothing_is_summed_up_with_its_skipped_sentences(monkeypatch):
    client, _, finished = _run(monkeypatch, lambda asked, n, kwargs: reply(''))
    assert finished['state'] == 'done'
    rows = _pieces(client)
    assert len(rows) == 2
    for r in rows:
        p = r['piece']
        assert p['counts'] == {}, 'it wrote nothing'
        assert p['note'] == ''
        assert {s['reason'] for s in p['skipped']} == {'no-answer'}
        assert [s['sentence'] for s in p['skipped']] == [p['first'], p['last']]
        assert all(s['document_id'] == 'd1' for s in p['skipped'])


def test_a_sentence_whose_model_work_failed_is_summed_up_as_skipped(monkeypatch):
    from plaid_agent.core.job import StretchFailed

    def answer(asked, n, kwargs=None):
        if 'Your piece: s1' in asked and len(targets_named(asked)) == 1:
            raise StretchFailed('output', 'too long')
        if targets_named(asked) and targets_named(asked)[0] == 1 and len(targets_named(asked)) > 1:
            raise StretchFailed('output', 'too long')
        return _gloss(asked, n)
    client, _, finished = _run(monkeypatch, answer)
    assert finished['state'] == 'done'
    failed = [r['piece'] for r in _pieces(client) if r['piece'].get('skipped')]
    assert [(p['first'], p['last'], p['skipped'][0]['reason'], p['skipped'][0]['kind']) for p in failed] == \
        [('s1', 's1', 'failed', 'output')]
    assert failed[0]['counts'] == {}


def test_a_plan_made_by_the_model_is_the_first_row(monkeypatch):
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 4)
    client = JobClient({'d1': _doc()})
    job = start(client, id=J, plan=None)
    _applying(monkeypatch, client)

    def answer(asked, n, kwargs=None):
        if asked.rstrip().endswith('Plan the job and end with plan_work.'):
            if n == 1:
                return reply(calls=[call(1, 'read_document', {'document': 'Story'})])
            if n == 2:
                return reply(calls=[call(2, 'plan_work', {'pieces': 'sentences', 'fills': ['segmentation',
                                                                                          'Morph Gloss']})])
            return reply('Planned.')
        return _gloss(asked, n)
    use(monkeypatch, Model(answer))
    assert run_job(job, runner(job))['state'] == 'done'
    rows = _pieces(client)
    assert rows[-1]['seq'] == '000000'
    plan = rows[-1]['piece']
    assert plan['plan'] == {'by': 'model', 'pieces': 'sentences', 'fills_names': ['segmentation', 'Morph Gloss']}
    assert plan['steps'] == 2 and plan['ended_at'].endswith('Z'), 'read_document and plan_work'
    assert [r['seq'] for r in rows] == ['000001', '000000']


def test_the_heartbeat_line_counts_the_steps_of_the_piece_and_sends_no_heartbeat_of_its_own(monkeypatch):
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    client = JobClient({'d1': _doc()})
    job = start(client, id=J, plan='sentences')
    _applying(monkeypatch, client)
    lines = []

    def answer(asked, n, kwargs=None):
        lines.append((job.status.get('message'), len([c for c in client.jobs.calls if c[0] == 'heartbeat'])))
        return _gloss(asked, n)
    use(monkeypatch, Model(answer))
    assert run_job(job, runner(job))['state'] == 'done'
    said = [m for m, _ in lines]
    assert said == ['Sentences 1 to 2 of 4.',
                    'Sentences 1 to 2 of 4. 6 steps in this piece.',
                    'Sentences 3 to 4 of 4.',
                    'Sentences 3 to 4 of 4. 6 steps in this piece.'], said
    beats = [b for _, b in lines]
    assert beats[0] == beats[1] and beats[2] == beats[3], 'a call sends no heartbeat'


def test_planning_counts_its_steps_on_its_line(monkeypatch):
    client = JobClient({'d1': _doc()})
    job = start(client, id=J, plan=None)
    lines = []

    def answer(asked, n, kwargs=None):
        if asked.rstrip().endswith('Plan the job and end with plan_work.'):
            lines.append(job.status.get('message'))
            if n == 1:
                return reply(calls=[call(1, 'read_document', {'document': 'Story'})])
            return reply(calls=[call(2, 'plan_work', {'pieces': 'sentences', 'fills': ['Morph Gloss']})])
        return reply('Nothing to do.')
    use(monkeypatch, Model(answer))
    run_job(job, runner(job))
    assert lines[:2] == ['Planning the work.', 'Planning the work. 1 step.'], lines


# --- recovery: never twice, never what did not land ------------------------------------------

@pytest.mark.parametrize('how', ['lost', 'crash'])
@pytest.mark.parametrize('seed', range(0, 40, 3))
def test_after_a_cut_no_piece_is_summed_up_twice_or_claims_a_write_that_did_not_land(monkeypatch, seed, how):
    """The RX property's job, cut after each request in turn (its answer
    lost, or the worker dead and a new one taking it up): each piece is
    summed up at most once, the sequence numbers go on from the highest
    core holds, and the summaries' counts never pass what landed (the
    document row's counts, from the same rows). After a lost answer every
    piece is summed up, so they sum to the row exactly."""
    with monkeypatch.context() as m:
        probe = tries.World(m, seed)
        probe.run()
        total = len(probe.client.landed_keys)
    for k in range(1, total + 1):
        with monkeypatch.context() as m:
            world = tries.World(m, seed, fail=(k, how))
            r = world.run()
            r.end_summaries()
            rows = [(key, json.loads(x['analysis'])) for (f, key), x in world.client.jobs.decision_rows[tries.J].items()
                    if f == PIECE_FORM]
            pieces = [v['piece'] for _, v in rows]
            assert len(pieces) == len(set(pieces)), (k, how, 'a piece summed up twice')
            seqs = sorted(int(key) for key, _ in rows)
            assert seqs == list(range(1, len(seqs) + 1)), (k, how, seqs)
            counts = world.job.rows['d1']['counts']
            for name in ('changes', 'deletions', 'words', 'links', 'entries', 'analyzed'):
                summed = sum((v.get('counts') or {}).get(name, 0) for _, v in rows)
                if how == 'lost':
                    assert summed == counts.get(name, 0), (k, how, name, summed, counts)
                else:
                    assert summed <= counts.get(name, 0), (k, how, name, summed, counts)


# --- REV-LV-1: a piece this worker takes again gets a row of its own ------------------------

def _summaries(client, job_id):
    return sorted(((k, json.loads(x['analysis'])) for (f, k), x in client.jobs.decision_rows[job_id].items()
                   if f == PIECE_FORM), key=lambda kv: kv[0])


@pytest.mark.parametrize('pieces', ['sentences', 'document', 'selection'])
def test_a_piece_taken_again_after_a_person_edited_its_first_sentence_has_a_row_of_its_own(monkeypatch, pieces):
    """REV-LV-1 (test_job_gate's "a sentence a person edits during the piece is
    taken again"): the walk takes the piece again from the same first
    sentence, so under the same key. Its write lands, and its row is kept
    with the next number: the rows sum to the document's counts."""
    import test_job_gate as gate
    client, job, clock, _ = gate._job(monkeypatch, pieces, after=gate.BLANK)
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
        return gate._gloss()(asked, n, kwargs)
    use(monkeypatch, Model(model))
    gate._staged(monkeypatch)
    runner(job).work(job)
    counts = job.rows['d1']['counts']
    rows = [v for k, v in _summaries(client, gate.J) if k != '000000']
    for name in ('words', 'changes', 'analyzed'):
        assert sum((v.get('counts') or {}).get(name, 0) for v in rows) == counts.get(name, 0), (name, rows, counts)


# --- REV-LV-2: a summary never fails the job ------------------------------------------------

def test_a_summary_over_the_cap_is_cut_and_says_so():
    from plaid_agent.igt.job import summary_text
    value = {'piece': 'k', 'document': 'd1', 'name': 'N' * 500, 'note': 'x' * 400,
             'fields': [{'field': 'F' * 300 + str(i), 'id': f'id-{i}', 'values': 1} for i in range(20)],
             'outside': [{'field': 'O' * 300 + str(i), 'id': f'od-{i}', 'values': 1} for i in range(20)]}
    text = summary_text(value)
    assert len(text) <= 4000
    row = json.loads(text)
    assert row['cut'] is True
    assert row['outside-more'] + len(row.get('outside') or []) == 20
    assert row['fields-more'] + len(row.get('fields') or []) == 20 or 'fields-more' not in row
    small = json.loads(summary_text({'piece': 'k', 'note': 'Fine.'}))
    assert 'cut' not in small


def test_a_summary_with_nothing_left_to_cut_but_its_name_and_note_is_cut_there():
    from plaid_agent.igt.job import summary_text
    row = json.loads(summary_text({'piece': 'k', 'name': 'N' * 3800, 'note': 'y' * 400}))
    assert row['cut'] is True and len(json.dumps(row)) <= 4000
    assert row['name'].startswith('NNN') and row['note'].startswith('yyy')


def test_a_summary_core_refuses_is_left_out_and_the_job_goes_on(monkeypatch):
    """REV-LV-2 (the reviewer's probe): a document name of 3,800 characters,
    which the fake keeps. The job ends done, its summaries cut."""
    import test_job_gate as gate
    client, job, clock, _ = gate._job(monkeypatch, 'sentences')
    client._holder('d1')['documents']['d1']['name'] = 'N' * 3800
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    rows = [v for k, v in _summaries(client, gate.J) if k != '000000']
    assert rows and all(v['cut'] is True for v in rows)


def test_a_refusal_of_a_summary_is_logged_and_the_job_goes_on(monkeypatch, caplog):
    from plaid_client import PlaidAPIError
    import test_job_gate as gate
    client, job, clock, _ = gate._job(monkeypatch, 'sentences')
    real = job.add_decisions

    def add(decisions):
        if any(d['form'] == PIECE_FORM for d in decisions):
            raise PlaidAPIError('HTTP 400 no', status=400, method='POST')
        return real(decisions)
    monkeypatch.setattr(job, 'add_decisions', add)
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    assert any('summary' in r.getMessage() for r in caplog.records)


def test_an_oversized_plan_summary_never_fails_the_planning(monkeypatch):
    client = JobClient({'d1': _doc()})
    job = start(client, id=J, plan=None)
    monkeypatch.setattr(igt_job.IgtRunner, 'fills_named',
                        lambda self, job, plan: {'fills_names': ['F' * 500 + str(i) for i in range(20)]})

    def answer(asked, n, kwargs=None):
        if asked.rstrip().endswith('Plan the job and end with plan_work.'):
            return reply(calls=[call(1, 'plan_work', {'pieces': 'sentences', 'fills': ['Morph Gloss']})]) \
                if n == 1 else reply('Planned.')
        return reply('Nothing to do.')
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    plan = dict(_summaries(client, J))['000000']
    assert plan['cut'] is True and plan['plan']['fills-names-more'] > 0


# --- REV-LV-3: a selection run again after a crash counts what it wrote ---------------------

def test_a_selection_run_again_after_a_crash_counts_what_its_earlier_try_wrote(monkeypatch):
    """The worker dies on the selection's summary call, after its write. The
    next worker runs the selection again, which writes nothing new: its row
    says what the selection's writes landed, not "Nothing written.". The
    rows then sum to the document's counts."""
    import test_job_gate as gate
    client, job, clock, _ = gate._job(monkeypatch, 'selection')
    gate._staged(monkeypatch)
    real = job.add_decisions

    def add(decisions):
        if any(d['form'] == PIECE_FORM and d['key'] != '000000' for d in decisions):
            raise gate.Crash()
        return real(decisions)
    monkeypatch.setattr(job, 'add_decisions', add)
    with pytest.raises(gate.Crash):
        runner(job).work(job)
    monkeypatch.setattr(job, 'add_decisions', real)
    clock['t'] += 3600
    gate._resume(client, job).work(job)
    counts = job.rows['d1']['counts']
    rows = [v for k, v in _summaries(client, gate.J) if k != '000000']
    assert len(rows) == 1 and rows[0]['document'] is None
    assert rows[0]['counts'].get('words', 0) == counts['words'] > 0, (rows, counts)
