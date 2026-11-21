"""A piece whose model answers nothing (REV-DAY-S-16): an answer that staged
nothing and wrote no text (reasoning only, or empty) is asked again once with
a fixed line, under the same budgets. When the second answer is the same,
a stretch of several sentences is halved as any failed stretch is, and a
piece of one sentence is skipped with a reason of its own (``no-answer``),
never counted as worked. Decided by what the answer holds, never its words."""

import pytest

from job_fixtures import JobClient, Model, call, document, reply, runner, start, targets_named, use

from plaid_agent.core import job as core_job
from plaid_agent.core.job import run_job
from plaid_agent.core.prompt import JOB_ANSWER_AGAIN
from plaid_agent.igt import job as igt_job

J = 'JNA'
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


def _asked_again(kwargs):
    return kwargs['messages'][-1].get('content') == JOB_ANSWER_AGAIN


def _stage(asked):
    mine = targets_named(asked) if 'Your piece: s' in asked else list(range(1, N + 1))
    return reply(calls=[call(10 * s + w, 'set_analysis', {'document': 'Story', 'ref': f's{s}.w{w}', 'morphemes': [
        {'form': 'x', 'fields': {'Morph Gloss': 'g'}}]}) for s in mine for w in (1, 2)])


def _run(monkeypatch, plan, answer):
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    client = JobClient({'d1': _doc()})
    job = start(client, id=J, plan=plan)
    _applying(monkeypatch, client)
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    return finished, model


@pytest.mark.parametrize('plan', ['sentences', 'document'])
@pytest.mark.parametrize('nothing', [None, '', '   '])
def test_an_answer_of_nothing_is_asked_again_once_and_its_second_answer_written(monkeypatch, plan, nothing):
    """Every piece first answers with no call and no text: it is sent the
    fixed line once, stages, and its words are written. Nothing skipped."""
    def answer(asked, n, kwargs):
        return _stage(asked) if _asked_again(kwargs) else reply(nothing)
    finished, model = _run(monkeypatch, plan, answer)
    assert finished['state'] == 'done'
    (doc,) = finished['report']['documents']
    assert doc['counts']['words'] == 2 * N and doc['skipped'] == [], doc
    agains = [c for c in model.calls if _asked_again(c['kwargs'])]
    assert agains and all(c['n'] == 2 for c in agains)
    # Asked again once per piece: the fixed line never twice in one context.
    assert all(sum(1 for m in c['kwargs']['messages'] if m.get('content') == JOB_ANSWER_AGAIN) == 1 for c in agains)
    assert finished['report']['totals']['skipped_no_answer'] == 0


@pytest.mark.parametrize('plan', ['sentences', 'document'])
def test_a_piece_that_answers_nothing_twice_has_its_sentences_skipped_as_no_answer(monkeypatch, plan):
    """s1-s2's piece answers nothing, and nothing again: its sentences are
    skipped "no-answer", not worked, not Left blank, and the totals count
    them. The other piece is written. Under a plan by documents the whole
    document answers nothing first and goes to stretches (REV-RW-6), whose
    s1-s2 piece then does the same."""
    def answer(asked, n, kwargs):
        if 'Your piece: the whole document' in asked or set(targets_named(asked)) & {1, 2}:
            return reply(None)
        return _stage(asked) if n == 1 else reply('Done.')
    finished, model = _run(monkeypatch, plan, answer)
    assert finished['state'] == 'done'
    (doc,) = finished['report']['documents']
    skipped = ['s1', 's2']
    assert [s['sentence'] for s in doc['skipped']] == skipped
    assert all(s['reason'] == igt_job.NO_ANSWER and s['kind'] is None for s in doc['skipped'])
    assert finished['report']['totals']['skipped_no_answer'] == len(skipped)
    assert not any(e['sentence_id'] in {f'd1-{x}' for x in skipped} for e in doc['left']), doc['left']
    assert doc['counts']['words'] == 2 * (N - len(skipped))
    assert doc['counts'].get('analyzed', 0) == N - len(skipped)
    nothing = [c for c in model.calls if 'Your piece: the whole document' in c['asked']
               or set(targets_named(c['asked'])) & {1, 2}]
    # Two calls a piece: the answer, and the one asked again. Never a third.
    # The stretch s1-s2 that answered nothing is halved, and each sentence
    # asked on its own the same way before it is skipped.
    assert [c['n'] for c in nothing] == [1, 2] * (3 if plan == 'sentences' else 4)


def test_a_stretch_that_answers_nothing_twice_is_halved(monkeypatch):
    """s1-s2's piece answers nothing twice. It is worked again as s1 and
    then s2, as a stretch that failed any other way is: s1 alone is written,
    s2 alone answers nothing twice and only it is skipped."""
    def answer(asked, n, kwargs):
        if 2 in targets_named(asked):
            return reply(None)
        return _stage(asked) if n == 1 else reply('Done.')
    finished, model = _run(monkeypatch, 'sentences', answer)
    (doc,) = finished['report']['documents']
    assert [(s['sentence'], s['reason'], s['kind']) for s in doc['skipped']] == [('s2', igt_job.NO_ANSWER, None)]
    assert finished['report']['totals']['skipped_no_answer'] == 1
    assert doc['counts']['words'] == 2 * (N - 1)
    pieces = [targets_named(c['asked']) for c in model.calls if c['n'] == 1]
    assert pieces[:3] == [[1, 2], [1], [2]], pieces


@pytest.mark.parametrize('plan', ['sentences', 'document'])
def test_the_blanks_of_skipped_sentences_are_counted_apart(monkeypatch, plan):
    """REV-DF-D-9: the blank words of the sentences skipped as no-answer
    are counted per target beside left and not reached (``skipped``), never
    listed, in the documents' and the totals' rows, the final context and
    read_job, so no target reads 0 blank while skipped sentences hold
    blanks of it."""
    from plaid_agent.igt import jobread

    def answer(asked, n, kwargs):
        if 'Your piece: the whole document' in asked or set(targets_named(asked)) & {1, 2}:
            return reply(None)
        return _stage(asked) if n == 1 else reply('Done.')
    finished, _ = _run(monkeypatch, plan, answer)
    report = finished['report']
    (doc,) = report['documents']
    words = 4
    rows = [{'target': 'segmentation', 'unit': 'word', 'left': 0, 'untouched': 0, 'not_reached': 0, 'skipped': words},
            {'target': 'Morph Gloss', 'unit': 'morpheme', 'left': 0, 'untouched': 0, 'not_reached': 0,
             'skipped': 0}]
    # Each blank word holds no morpheme: counted once, as a word, under
    # segmentation, never again as a morpheme (RPF-A9, RP-3).
    assert doc['counts']['blank'] == rows and report['totals']['blank'] == rows
    message = igt_job.summary_message(report)
    assert (f'Of what it fills: segmentation left blank 0 words ({words} more in skipped sentences), Morph Gloss '
            f'left blank 0 morphemes.') in message, message
    assert f'segmentation left blank 0 words ({words} more in skipped sentences)' in jobread._totals(report)


def test_an_answer_with_a_line_and_nothing_staged_is_not_asked_again(monkeypatch):
    """A piece that says "Nothing to change." and stages nothing is worked
    as before: one call, not asked again, not skipped."""
    finished, model = _run(monkeypatch, 'sentences', lambda asked, n, kwargs: reply('Nothing to change.'))
    (doc,) = finished['report']['documents']
    assert doc['skipped'] == [] and not any(_asked_again(c['kwargs']) for c in model.calls)
    assert all(c['n'] == 1 for c in model.calls)


def test_an_answer_that_staged_and_said_nothing_is_not_asked_again(monkeypatch):
    """A piece that stages and ends with no text is not asked again."""
    def answer(asked, n, kwargs):
        return _stage(asked) if n == 1 else reply(None)
    finished, model = _run(monkeypatch, 'sentences', answer)
    (doc,) = finished['report']['documents']
    assert doc['counts']['words'] == 2 * N and doc['skipped'] == []
    assert not any(_asked_again(c['kwargs']) for c in model.calls)


def test_a_piece_that_read_and_then_answered_nothing_is_asked_again(monkeypatch):
    """Calls that stage nothing (a read) and an empty end: staged nothing,
    said nothing, so it is asked again."""
    def answer(asked, n, kwargs):
        if _asked_again(kwargs):
            return _stage(asked)
        if n == 1:
            return reply(calls=[call(1, 'read_lexicon', {'query': 'ka'})])
        if n == 2:
            return reply(None)
        return reply('Done.')
    finished, model = _run(monkeypatch, 'sentences', answer)
    (doc,) = finished['report']['documents']
    assert doc['counts']['words'] == 2 * N and doc['skipped'] == []
    assert any(_asked_again(c['kwargs']) for c in model.calls)


def test_asked_again_under_the_same_budget(monkeypatch):
    """The second ask counts its call with the first answer's: a stretch of
    one call allowed has no room for it, so the stretch fails as over budget
    (halved, then skipped as failed), never given a second budget."""
    monkeypatch.setattr(core_job, 'JOB_STRETCH_MAX_ROUNDS', 1)
    monkeypatch.setattr(core_job, 'JOB_STRETCH_DECIDE_AT_ROUNDS', 99)
    finished, model = _run(monkeypatch, 'sentences', lambda asked, n, kwargs: reply(None))
    (doc,) = finished['report']['documents']
    assert {s['reason'] for s in doc['skipped']} == {'failed'}
    assert {s['kind'] for s in doc['skipped']} == {core_job.BUDGET}
    assert not any(_asked_again(c['kwargs']) for c in model.calls)


def test_a_selection_that_answers_nothing_twice_leaves_its_documents_to_the_walk(monkeypatch):
    """The selection's piece answers nothing twice: it read no document,
    so each is worked as a piece of its own (the existing fallback), whose
    words are written."""
    def answer(asked, n, kwargs):
        if 'Your piece: the whole selection' in asked:
            return reply(None)
        return _stage(asked) if n == 1 else reply('Done.')
    finished, model = _run(monkeypatch, 'selection', answer)
    (doc,) = finished['report']['documents']
    assert doc['counts']['words'] == 2 * N and doc['skipped'] == []
    selection = [c for c in model.calls if 'Your piece: the whole selection' in c['asked']]
    assert [c['n'] for c in selection] == [1, 2]
