"""Tests written by the planted-faults campaign PF, agent 3 (job.py, the
plan's storage through the walk's pending rule): each catches a fault the job
test set let through, planted in igt/job.py and reverted."""

import json

from job_fixtures import JobClient, Model, call, document, empty_words, reply, runner, start, use

from plaid_agent.core.job import run_job

J = 'JPF3'
PLANNING = 'Plan the job and end with plan_work.'


def _docs(n=1):
    return {f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['ka', 'ta'], 'translation': ('T.', 'human')},
                                                       {'words': ['sa'], 'translation': ('S.', 'human')}])
            for i in range(1, n + 1)}


def _planning(asked):
    return asked.rstrip().endswith(PLANNING)


def _gloss_all(asked, n):
    if n > 1:
        return reply('Glossed every blank word of the piece.')
    doc = asked.split('"')[1]
    calls = []
    for s, words in empty_words(asked):
        for w, form in words:
            calls.append(call(len(calls) + 1, 'set_analysis', {'document': doc, 'ref': f's{s}.w{w}',
                                                              'morphemes': [{'form': form,
                                                                             'fields': {'Morph Gloss': 'G'}}]}))
    return reply(calls=calls)


def _plan_rows(client):
    return [json.loads(r['analysis']) for (f, _k), r in client.jobs.decision_rows.get(J, {}).items() if f == ' plan']


def test_a_planner_that_kept_a_plan_and_then_spent_its_budget_on_reads_keeps_the_plan(monkeypatch):
    """planning(): a StretchFailed (its budget spent, nothing staged) after
    plan_work kept a plan loses nothing: the plan is worked. Planted, the
    budget's failure went up and the job ended no-plan, writing nothing."""
    client = JobClient(_docs())
    job = start(client, id=J, plan=None)

    def answer(asked, n, kwargs):
        if _planning(asked):
            if n == 1:
                return reply(calls=[call(91, 'plan_work', {'pieces': 'sentences',
                                                           'fills': ['segmentation', 'Morph Gloss']})])
            # A new place each call, so no repeat stops it: its budget does.
            return reply(calls=[call(1000 + n, 'read_document', {'document': 'Story 1', 'from': n})])
        return _gloss_all(asked, n)
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished['state'], finished.get('reason'))
    assert _plan_rows(client)[0]['by'] == 'model'
    assert client.writes, 'the plan was worked'
    assert sum(1 for c in model.calls if _planning(c['asked']) and len(c['kwargs']['messages']) == 2) == 1, \
        'planned once'


def test_a_split_off_half_holding_a_word_the_job_wrote_is_never_handed_to_a_model(monkeypatch):
    """pending() under a plan that takes every sentence (the default): a
    sentence holding a word of a sentence the job wrote in is not taken
    again, whatever its id now (REV-B4-1). Planted (the wrote_in test
    dropped), the half a person split off after the job wrote it, its word
    cleared, was handed to a model once more: a job that revises would
    rewrite there."""
    from test_job_reshape import _after_record, _job, _person_leaves, _written, gloss, mine, reshaped
    client, job, clock = _job(monkeypatch, [{'words': ['ka', 'ta', 'pa']}, {'words': ['sa']}])
    model = use(monkeypatch, Model(gloss))
    client.after_write['d1'] = document('d1', 'Story', [{'words': [mine('ka'), mine('ta'), mine('pa')]},
                                                         {'words': ['sa']}], version=2)
    split = reshaped(document('d1', 'Story', [{'words': [mine('ka'), mine('ta')]}, {'words': ['pa']},
                                              {'words': ['sa']}], version=3),
                     {'d1-s2w1': 'd1-s1w3', 'd1-s2': 'd1-sNEW', 'd1-s3w1': 'd1-s2w1', 'd1-s3': 'd1-s2'})
    _after_record(monkeypatch, job, 'd1-s1', lambda: _person_leaves(client, split, clock))
    seen = _written(monkeypatch)
    assert runner(job).document('d1') == 'done'
    assert seen == [['d1-s1w1', 'd1-s1w2', 'd1-s1w3'], ['d1-s2w1']], seen
    pieces = [line for c in model.calls if c['n'] == 1 for line in c['asked'].splitlines()
              if line.startswith('Your piece:')]
    assert len(pieces) == 2, ('s1, then the sentence of sa: never the split-off half', pieces)


def test_a_matched_document_with_nothing_left_to_take_counts_what_the_walk_took(monkeypatch):
    """walk() under a plan limited by a search: a document whose matched
    sentences the walk takes none of (skip_filled_sentences, its match full)
    ends with targets as done, never the count of its matches (SF: what the
    walk took is all it finished). Planted (the line dropped), its row read
    0 done of 1 for a document with nothing to do."""
    from job_fixtures import planned
    from plaid_agent.igt import job as igt_job
    from test_job_search_walk import OLD, SEARCH, _pieces, _your_piece
    client = JobClient({
        'd1': document('d1', 'Story 1', [{'words': [('nidr', [('nidr', OLD)], 'human'), 'sa']}]),
        'd2': document('d2', 'Story 2', [{'words': [('nidr', [('nidr', OLD)], 'human'),
                                                    ('ka', [('ka', 'go')], 'human')]}])})
    job = start(client, 'Gloss what is empty where the old gloss is.', id=J, plan=None)
    model = use(monkeypatch, Model(planned(lambda a, k, kw: reply('Nothing to add.'),
                                           {'pieces': 'sentences', 'fills': ['segmentation', 'Morph Gloss'],
                                            'skip_filled_sentences': True, 'search': SEARCH})))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    assert [(_your_piece(a).split('.')[0], a.split('"')[1]) for a in _pieces(model)] == [('Your piece: s1', 'Story 1')]
    rows = {d['name']: d for d in finished['report']['documents']}
    d2 = rows['Story 2']
    assert (d2['state'], d2['targets'], d2['done'], d2['counts'][igt_job.MATCHED]) == ('done', 0, 0, 1), \
        ('a matched document the walk took nothing of', d2['targets'], d2['done'])
