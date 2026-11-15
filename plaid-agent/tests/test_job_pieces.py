"""A job's model contexts (the owner's rulings 14 and 15 of 2026-11-13): the
planning context, made once and kept; pieces of the three sizes; a piece's
note and the tables its code makes; the final context that writes the
report's prose; and a crash and resume at each new step."""

import json
import re

import pytest

from job_fixtures import every_tool, JobClient, Model, call, document, empty_words, keep_plan, reply, runner, start, use

from plaid_agent.core import sandbox
from plaid_agent.core.job import run_job
from plaid_agent.core.prompt import JOB_PLAN_NOW
from plaid_agent.igt import job as igt_job


@pytest.fixture(autouse=True)
def _every_tool(monkeypatch):
    """These tests script tools a piece of a plan in sentences is no longer offered."""
    every_tool(monkeypatch)


J = 'JP'
PLANNING = 'Plan the job and end with plan_work.'
SUMMARY = 'Write the summary now.'


def _docs(n=2):
    return {f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['ka', 'ta'], 'translation': ('T.', 'human')},
                                                       {'words': ['sa'], 'translation': ('S.', 'human')}])
            for i in range(1, n + 1)}


def _plan_rows(client):
    return [json.loads(r['analysis']) for (f, _k), r in client.jobs.decision_rows.get(J, {}).items() if f == ' plan']


def _kind(asked):
    if asked.rstrip().endswith(PLANNING):
        return 'plan'
    if asked.rstrip().endswith(SUMMARY):
        return 'summary'
    return 'piece'


def _model(plan=None, piece=None, summary='The job glossed the words it was asked to.'):
    """A model that plans with ``plan`` (args of plan_work, or None to end
    without), does ``piece(asked, n)`` for a piece, and writes ``summary``.
    A plan that does not say what it fills fills a glossing job's targets
    (fills is required, REV-DF-D-1)."""
    seen = {'plan': 0, 'piece': 0, 'summary': 0}
    if plan is not None:
        plan = {'fills': ['segmentation', 'Morph Gloss'], **plan}

    def answer(asked, n, kwargs):
        kind = _kind(asked)
        seen[kind] += n == 1
        if kind == 'plan':
            told = any(m.get('content') == JOB_PLAN_NOW for m in kwargs['messages'])
            if plan is not None and (n == 1 or told):
                return reply(calls=[call(90 + n, 'plan_work', plan)])
            return reply('Planned.')
        if kind == 'summary':
            if isinstance(summary, Exception):
                raise summary
            return reply(summary)
        return piece(asked, n) if piece else reply('Nothing to do here.')
    model = Model(answer)
    model.seen = seen
    return model


def _gloss_all(asked, n):
    if n > 1:
        return reply('Glossed every blank word of the piece.')
    doc = asked.split('"')[1]
    import re
    calls = []
    for s, words in empty_words(asked):
        for w, form in words:
            calls.append(call(len(calls) + 1, 'set_analysis', {'document': doc, 'ref': f's{s}.w{w}',
                                                              'morphemes': [{'form': form, 'fields': {'Morph Gloss': 'G'}}]}))
    return reply(calls=calls)


# --- the plan ---------------------------------------------------------------------------

def test_the_first_context_plans_and_the_plan_is_kept_and_reported(monkeypatch):
    client = JobClient(_docs())
    job = start(client, 'Segment and gloss the blank words.', id=J, plan=None)
    model = use(monkeypatch, _model(plan={'pieces': 'sentences', 'piece_instructions': 'Gloss ka as go.',
                                          'fills': ['segmentation', 'Morph Gloss']}, piece=_gloss_all))
    finished = run_job(job, runner(job, write_summary=True))
    assert finished['state'] == 'done'
    assert model.calls[0]['asked'].splitlines()[0] == 'Instructions from user:'
    asked = model.calls[0]['asked']
    assert "What a job can fill (name them in plan_work's fills):\n- segmentation (word level: words into " \
           'morphemes)\n- "Gloss" (word level)\n- "Morph Gloss" (morpheme level)\n- "Translation" (sentence level)\n' \
           '- "IPA" (orthography, word level)' \
           in asked, asked
    # Only what has something empty (DF1 open point 3): Translation 0 is not named.
    assert 'Story 1": 2 sentences, 3 words, 81 characters. Empty: segmentation 3, Gloss 3, Morph Gloss 3, IPA 3.\n' \
        in asked, asked
    plan_tools = {t['function']['name'] for t in model.calls[0]['kwargs']['tools']}
    assert 'plan_work' in plan_tools and 'set_analysis' not in plan_tools
    assert _plan_rows(client) == [{'pieces': 'sentences', 'documents': None, 'by': 'model', 'why': None,
                                   'fills': ['segmentation', 'sl-mgloss']}]
    assert [r['analysis'] for (f, _k), r in client.jobs.decision_rows[J].items()
            if f == igt_job.PLAN_INSTRUCTIONS_FORM] == ['Gloss ka as go.']
    pieces = [c['asked'] for c in model.calls if _kind(c['asked']) == 'piece' and c['n'] == 1]
    assert pieces and all('Instructions from user:\nSegment and gloss the blank words.' in p for p in pieces), \
        'the instructions verbatim'
    assert all('How to do every piece, as the job was planned:\nGloss ka as go.' in p for p in pieces), 'and the plan'
    assert finished['report']['plan']['pieces'] == 'sentences' and finished['report']['plan']['fallback'] == []
    # By the names the project gives its targets, for the page and read_job (REV-DF-D-1).
    assert finished['report']['plan']['fills_names'] == ['segmentation', 'Morph Gloss']
    assert finished['report']['summary'] == 'The job glossed the words it was asked to.'
    assert finished['report']['summary_failed'] is False


#: The plan a job keeps and reports when planning ended with none
#: (REV-DF3-2): it names nothing to work, and the job writes nothing.
NO_PLAN = {'by': 'none', 'why': 'no-plan', 'piece_instructions': '', 'fallback': [], 'left_out': []}


def _ended_with_no_plan(client, finished, model):
    """A job whose planning ended with no plan: failed, reason no-plan, no
    piece and no final context asked, nothing written, every document not
    reached."""
    assert finished['state'] == 'failed' and finished['reason'] == 'no-plan', finished
    assert finished['report']['plan'] == NO_PLAN, finished['report']['plan']
    assert [c for c in model.calls if _kind(c['asked']) != 'plan'] == [], 'no piece, no final context'
    assert not client.writes, 'nothing written'
    assert {d['state'] for d in finished['report']['documents']} == {'not-reached'}
    assert finished['report']['summary'] is None


def test_a_planning_that_ends_without_a_plan_gets_one_decide_now_round_then_the_job_ends_writing_nothing(
        monkeypatch):
    """REV-DF3-2, the lead's ruling: no plan is never the app's default
    plan (it filled segmentation, the gloss and the translation whatever
    the job was asked). The planner is asked once more to end with
    plan_work, alone offered, and then the job ends failed, writing
    nothing."""
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)
    model = use(monkeypatch, _model(plan=None, piece=_gloss_all))
    finished = run_job(job, runner(job, write_summary=True))
    planning = [c for c in model.calls if _kind(c['asked']) == 'plan']
    assert len(planning) == 2, 'the planning, then one round told to end with plan_work'
    assert any(m.get('content') == JOB_PLAN_NOW for m in planning[1]['kwargs']['messages'])
    assert {t['function']['name'] for t in planning[1]['kwargs']['tools']} == {'plan_work'}
    _ended_with_no_plan(client, finished, model)
    assert _plan_rows(client) == [{'by': 'none', 'why': 'no-plan'}], 'kept, so a resumed job ends the same'


def test_a_planning_that_runs_out_of_budget_ends_the_job_writing_nothing(monkeypatch):
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)

    def answer(asked, n, kwargs):
        if _kind(asked) == 'plan':
            return reply(calls=[call(n, 'read_document', {'document': 'Story 1'})])
        return _gloss_all(asked, n)
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    # Told to decide, it is offered plan_work alone, and its reads are refused
    # until its turn ends: no plan, so the job ends.
    _ended_with_no_plan(client, finished, model)


def test_a_planner_refused_until_it_gives_up_ends_the_job_writing_nothing(monkeypatch):
    """REV-DF3-2's J7: a check whose planner calls plan_work with no fills,
    is refused, and answers text, twice. The job is not run as glossing."""
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None, instructions='Check the glosses for consistency and report.')

    def answer(asked, n, kwargs):
        if _kind(asked) == 'plan':
            return reply(calls=[call(n, 'plan_work', {'pieces': 'sentences'})]) if n == 1 else reply('Planned.')
        return _gloss_all(asked, n)
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    planning = [c for c in model.calls if _kind(c['asked']) == 'plan']
    assert any('fills: say what the job fills' in str(m.get('content')) for c in planning
               for m in c['kwargs']['messages']), 'refused'
    _ended_with_no_plan(client, finished, model)


@pytest.mark.parametrize('fills', ['segmentation, Morph Gloss', '["segmentation", "Morph Gloss"]'])
def test_a_planner_that_sends_fills_as_one_string_has_its_plan_kept(monkeypatch, fills):
    """REV-DF4-1 (REV-DF4's r2_seq string-list-repeated): a list sent as
    one string, every time, was refused three times and the job failed.
    It is read as the list it names, and the job is worked."""
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)
    model = use(monkeypatch, _model(plan={'pieces': 'sentences', 'fills': fills}, piece=_gloss_all))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    assert _plan_rows(client)[0]['fills'] == ['segmentation', 'sl-mgloss']
    assert len([c for c in model.calls if _kind(c['asked']) == 'plan']) == 2, 'planned, then its one-line end'


def _plan_args():
    return {'pieces': 'sentences', 'fills': ['segmentation', 'Morph Gloss']}


def _fresh(c):
    """Whether a model call is the first of a context: its system prompt
    and its message, nothing else."""
    return [m['role'] for m in c['kwargs']['messages']] == ['system', 'user']


def test_a_planning_that_ends_in_a_model_fault_is_planned_once_more_in_a_fresh_context(monkeypatch):
    """REV-DF4-2 (a): one provider refusal in the planning call ended the
    job failed. A planning that ends in a model fault (the worker's own
    StretchFailed kinds) is planned once more, in a fresh context."""
    import litellm
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)
    seen = {'faults': 0}

    def answer(asked, n, kwargs):
        if _kind(asked) == 'plan':
            if not seen['faults']:
                seen['faults'] += 1
                raise litellm.BadRequestError('bad tool call json', model='m', llm_provider='openai')
            return reply(calls=[call(90 + n, 'plan_work', _plan_args())]) if n == 1 else reply('Planned.')
        return _gloss_all(asked, n)
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    planning = [c for c in model.calls if _kind(c['asked']) == 'plan']
    assert [_fresh(c) for c in planning] == [True, True, False], 'the fault, a fresh context, its one-line end'
    assert _plan_rows(client)[0]['by'] == 'model'


def test_a_planning_that_ends_in_a_model_fault_twice_ends_the_job_failed_saying_so(monkeypatch):
    """REV-DF4-2 (a, c): twice, and the job ends failed writing nothing,
    its reason planning-failed (by the plan row's why, a StretchFailed kind,
    never by any text), apart from no-plan."""
    import litellm
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)

    def answer(asked, n, kwargs):
        if _kind(asked) == 'plan':
            raise litellm.BadRequestError('bad tool call json', model='m', llm_provider='openai')
        return _gloss_all(asked, n)
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'failed' and finished['reason'] == 'planning-failed', finished
    assert finished['report']['plan'] == {**NO_PLAN, 'why': 'output'}
    assert [_fresh(c) for c in model.calls] == [True, True], 'planned twice, no piece'
    assert not client.writes
    assert _plan_rows(client) == [{'by': 'none', 'why': 'output'}]


@pytest.mark.parametrize('kind,tries,reason', [('output', 2, 'planning-failed'), ('repeating', 2, 'planning-failed'),
                                               ('budget', 1, 'no-plan'), ('context', 1, 'no-plan')])
def test_only_a_model_fault_in_planning_is_planned_again_and_worded_as_one(monkeypatch, kind, tries, reason):
    """REV-DF5-1: a budget spent or a context too long is planned again and
    read "The assistant's model failed", though a second start ends the
    same. Only an output fault (the cap, a provider's refusal) and a model
    repeating itself are faults of the model: planned once more, and
    planning-failed. A budget or a context ends as no plan, planned once.
    By the StretchFailed's kind alone."""
    from plaid_agent.core.job import StretchFailed
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)
    seen = []

    def planning(self, project, facts):
        seen.append(kind)
        raise StretchFailed(kind, 'scripted')
    monkeypatch.setattr(igt_job.IgtRunner, 'planning', planning)
    model = use(monkeypatch, Model(lambda asked, n, kwargs: _gloss_all(asked, n)))
    finished = run_job(job, runner(job))
    assert len(seen) == tries
    assert finished['state'] == 'failed' and finished['reason'] == reason, finished
    assert _plan_rows(client) == [{'by': 'none', 'why': kind if reason == 'planning-failed' else 'no-plan'}]
    assert not client.writes and not model.calls


def test_a_planner_that_spends_its_budget_on_reads_ends_with_no_plan_planned_once(monkeypatch):
    """REV-DF5-1 (REV-DF5's worst case): a planner that reads a new place
    every call reaches its budget. Planning ended with no plan, once."""
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)

    def answer(asked, n, kwargs):
        if _kind(asked) == 'plan':
            return reply(calls=[call(1000 + n, 'read_document', {'document': 'Story 1', 'from': n})])
        return _gloss_all(asked, n)
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    _ended_with_no_plan(client, finished, model)
    assert sum(_fresh(c) for c in model.calls) == 1, 'planned once'


def test_a_model_fault_after_plan_work_kept_a_plan_keeps_it(monkeypatch):
    """REV-DF4-2 (a): the call after plan_work (its one-line end) failing
    lost the kept plan. The plan is kept and worked, never planned again."""
    import litellm
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)

    def answer(asked, n, kwargs):
        if _kind(asked) == 'plan':
            if n == 1:
                return reply(calls=[call(91, 'plan_work', _plan_args())])
            raise litellm.BadRequestError('bad', model='m', llm_provider='openai')
        return _gloss_all(asked, n)
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    assert len([c for c in model.calls if _kind(c['asked']) == 'plan']) == 2, 'never planned again'
    assert _plan_rows(client)[0]['by'] == 'model'


def _written(name='plan_work'):
    """The note a job's model is sent after a call written as text: the
    planner's for plan_work, a piece's for any other tool here."""
    from plaid_agent.core.agent import written_call_note
    from plaid_agent.core.prompt import JOB_PLAN_WRITTEN_CALL_NEXT, JOB_WRITTEN_CALL_NEXT
    return written_call_note(name, JOB_PLAN_WRITTEN_CALL_NEXT if name == 'plan_work' else JOB_WRITTEN_CALL_NEXT)


def test_a_planner_that_writes_plan_work_out_as_text_is_told_it_did_not_run(monkeypatch):
    """REV-DF4-2 (b): a job's turn sent no note for a call written as text,
    the chat's fixed one (core.agent.written_call, our own call syntax only).
    It now gets it once a turn, with the job's next step."""
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)

    def answer(asked, n, kwargs):
        if _kind(asked) == 'plan':
            if n == 1:
                return reply('plan_work(pieces="sentences", fills=["segmentation", "Morph Gloss"])')
            if n == 2:
                return reply(calls=[call(92, 'plan_work', _plan_args())])
            return reply('Planned.')
        return _gloss_all(asked, n)
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', finished.get('reason')
    planning = [c for c in model.calls if _kind(c['asked']) == 'plan']
    assert planning[1]['kwargs']['messages'][-1] == {'role': 'user', 'content': _written()}
    # REV-DF5-2: a planner has nothing to end without, so its way out is
    # plan_work, never an ending with no plan.
    assert _written() == ('(system) Your reply wrote a plan_work call as text, so it did not run: nothing was '
                          'done. Call the tool itself now, or end with plan_work.')


def test_a_planner_that_writes_plan_work_out_as_text_every_time_is_told_twice_and_ends_with_no_plan(monkeypatch):
    """REV-DF4-2 (b): the note once in the planning turn, the decide-now
    round, the note once in it, then no plan."""
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)

    def answer(asked, n, kwargs):
        if _kind(asked) == 'plan':
            return reply('plan_work(pieces="sentences", fills=["segmentation", "Morph Gloss"])')
        return _gloss_all(asked, n)
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    _ended_with_no_plan(client, finished, model)
    last = [c['kwargs']['messages'][-1]['content'] for c in model.calls]
    assert last[1:] == [_written(), JOB_PLAN_NOW, _written()], last


def test_a_planner_told_to_decide_by_its_budget_is_told_to_call_plan_work_and_still_gets_its_round(monkeypatch):
    """REV-DF4-2 (b): the budget's decide-now line sent to a planner was a
    piece's ("stage your work on the piece and end with your note"), and
    the decide-now round was then skipped. The planner is sent JOB_PLAN_NOW
    by its budget, and the round when it ends without a plan all the same."""
    from plaid_agent.core.limits import JOB_STRETCH_DECIDE_AT_ROUNDS
    from plaid_agent.core.prompt import JOB_DECIDE_NOW
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)

    def answer(asked, n, kwargs):
        if _kind(asked) == 'plan':
            if kwargs['messages'][-1].get('content') == JOB_PLAN_NOW:
                return reply('I will plan.')
            return reply(calls=[call(n, 'read_document', {'document': 'Story 1'})])
        return _gloss_all(asked, n)
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    _ended_with_no_plan(client, finished, model)
    sent = [m.get('content') for c in model.calls for m in c['kwargs']['messages']]
    assert JOB_DECIDE_NOW not in sent
    told = [c for c in model.calls if c['kwargs']['messages'][-1].get('content') == JOB_PLAN_NOW]
    assert len(told) == 2 and told[0]['n'] == JOB_STRETCH_DECIDE_AT_ROUNDS, [c['n'] for c in told]


def test_a_piece_that_writes_a_call_out_as_text_is_told_it_did_not_run(monkeypatch):
    """REV-DF4-2 (b): one code path for the note, a piece's and the
    planner's (the job's turn in core.agent)."""
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)
    told = []

    def piece(asked, n):
        return reply('set_analysis(document="Story 1", ref="s1.w1")') if n == 1 else reply('Done.')
    model = use(monkeypatch, _model(plan={'pieces': 'sentences'}, piece=piece))
    run_job(job, runner(job))
    pieces = [c for c in model.calls if _kind(c['asked']) == 'piece']
    told = [c for c in pieces if c['kwargs']['messages'][-1].get('content') == _written('set_analysis')]
    assert told and all(c['n'] == 2 for c in told), [c['kwargs']['messages'][-1] for c in pieces]
    # REV-DF5-2: a piece whose note quotes a call it decided against is
    # given a way out, as the chat's model is (to reply without the call).
    assert _written('set_analysis') == ('(system) Your reply wrote a set_analysis call as text, so it did not run: '
                                        'nothing was done. Call the tool itself now, or end without it.')


def test_a_stop_pressed_during_a_planning_that_ends_with_no_plan_ends_the_job_stopped(monkeypatch):
    """REV-DF4-3: Stop pressed in the planning's last round, unheard by a
    heartbeat before planning ended with no plan, ended the job failed
    (core takes failed from stopping). The job hears it first and ends
    stopped, writing nothing."""
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)

    def answer(asked, n, kwargs):
        if _kind(asked) == 'plan':
            if kwargs['messages'][-1].get('content') == JOB_PLAN_NOW:
                client.jobs.cancel(J)
            return reply('I will plan.')
        return _gloss_all(asked, n)
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'cancelled', (finished['state'], finished.get('reason'))
    assert not client.writes


def test_a_job_resumed_after_planning_ended_with_no_plan_ends_the_same(monkeypatch):
    """The plan that names nothing is kept: a worker that takes the job
    again after a crash reads it back, never plans again, and ends."""
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)
    client.jobs.add_decisions(J, 'worker-1', [_none_row()])
    job.set(phase='working')
    model = use(monkeypatch, _model(plan={'pieces': 'sentences'}, piece=_gloss_all))
    finished = run_job(job, runner(job))
    _ended_with_no_plan(client, finished, model)
    assert model.calls == [], 'never planned again'


def _none_row():
    from plaid_agent.core.job import analysis_key, canonical
    from plaid_agent.igt.job import PLAN_FORM
    text = canonical({'by': 'none', 'why': 'no-plan'})
    return {'form': PLAN_FORM, 'key': analysis_key(text), 'analysis': text, 'count': 1, 'document_id': None,
            'sentence_id': None}


def test_a_subset_of_documents_in_the_plans_order_and_the_rest_not_reached(monkeypatch):
    client = JobClient(_docs(3))
    job = start(client, id=J, plan=None)
    model = use(monkeypatch, _model(plan={'pieces': 'sentences', 'documents': ['Story 3', 'Story 1']},
                                    piece=_gloss_all))
    finished = run_job(job, runner(job))
    worked = []
    for c in model.calls:
        if _kind(c['asked']) == 'piece' and c['n'] == 1:
            name = c['asked'].split('"')[1]
            if name not in worked:
                worked.append(name)
    assert worked == ['Story 3', 'Story 1']
    assert [d['state'] for d in finished['report']['documents']] == ['done', 'not-reached', 'done']
    # Each document the plan left out is listed as such (the lead's ruling).
    assert finished['report']['plan']['left_out'] == [{'document_id': 'd2', 'name': 'Story 2'}]


def test_a_document_gone_at_the_checks_is_gone_and_not_left_out_by_the_plan(monkeypatch):
    """REV-JG2-7: Story 2 is deleted before the checks, and the plan names
    the other two. The report lists Story 2 as gone, never as left out by
    the plan."""
    from plaid_client import PlaidAPIError
    client = JobClient(_docs(3))
    job = start(client, id=J, plan=None)
    get = client.documents.get

    def going(document_id, **kw):
        if document_id == 'd2':
            raise PlaidAPIError('HTTP 404', status=404)
        return get(document_id, **kw)
    client.documents.get = going
    use(monkeypatch, _model(plan={'pieces': 'sentences', 'documents': ['Story 3', 'Story 1']}, piece=_gloss_all))
    finished = run_job(job, runner(job))
    assert [d['state'] for d in finished['report']['documents']] == ['done', 'gone', 'done']
    assert finished['report']['plan']['left_out'] == []


def test_a_resumed_job_does_not_plan_again(monkeypatch):
    """A crash after plan_work was kept: the next worker reads the plan back."""
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)
    use(monkeypatch, _model(plan={'pieces': 'document'}))

    class Crash(BaseException):
        pass
    r = runner(job)
    real = r.work

    def crash(j):
        raise Crash()
    r.work = crash
    with pytest.raises(Crash):
        run_job(job, r)
    assert job.status['phase'] == 'working' and len(_plan_rows(client)) == 1
    model = use(monkeypatch, _model(plan={'pieces': 'selection'}))
    finished = run_job(job, runner(job))
    assert not [c for c in model.calls if _kind(c['asked']) == 'plan'], 'no planning again'
    assert finished['report']['plan']['pieces'] == 'document'
    assert real


def test_a_plan_whose_row_meets_a_passing_error_is_kept_and_made_once(monkeypatch):
    """REV-JG-8: one 502 on the plan's own row. The plan is kept (a resumed
    job reads it back, the report shows it), and the planning context is
    not asked again for it."""
    from plaid_client import PlaidAPIError
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)
    model = use(monkeypatch, _model(plan={'pieces': 'document'}))
    real = job.add_decisions
    once = {'n': 1}

    def add(decisions):
        if once['n'] and any(d['form'] == igt_job.PLAN_FORM for d in decisions):
            once['n'] = 0
            raise PlaidAPIError('HTTP 502', status=502, method='POST')
        return real(decisions)
    monkeypatch.setattr(job, 'add_decisions', add)
    finished = run_job(job, runner(job))
    assert once['n'] == 0, 'the 502 was met'
    assert [p['pieces'] for p in _plan_rows(client)] == ['document']
    assert finished['report']['plan']['pieces'] == 'document'
    assert model.seen['plan'] == 1, 'planned once'


def test_the_largest_plan_the_tool_takes_is_kept_and_read_back_in_its_order(monkeypatch):
    """REV-JG-3: a job of the most documents a job takes, all named by the
    planning context in an order of its own, with the longest piece
    instructions plan_work accepts, written in the characters that cost
    most to keep. The plan fits one row, the job ends done, and a resumed
    job reads the same order back."""
    import uuid
    from plaid_agent.core.limits import JOB_ANALYSIS_MAX_CHARS, JOB_PIECE_INSTRUCTIONS_MAX_CHARS
    ids = [str(uuid.uuid4()) for _ in range(500)]
    glossed = [{'words': [('ka', [('ka', 'go')], 'human')], 'translation': ('T.', 'human')}]
    client = JobClient({d: document(d, f'Text {i}', glossed) for i, d in enumerate(ids)})
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan=None)
    told = '"\\\n' * (JOB_PIECE_INSTRUCTIONS_MAX_CHARS // 3)
    model = use(monkeypatch, _model(plan={'pieces': 'sentences', 'documents': list(reversed(ids)),
                                          'piece_instructions': told}))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished['state'], finished.get('reason'), finished.get('message'))
    rows = [r for (f, _), r in client.jobs.decision_rows[J].items() if f == igt_job.PLAN_FORM]
    assert len(rows) == 1 and len(rows[0]['analysis']) <= JOB_ANALYSIS_MAX_CHARS
    # The instructions are a row of their own, as written (BRIEF PF).
    told_rows = [r for (f, _), r in client.jobs.decision_rows[J].items() if f == igt_job.PLAN_INSTRUCTIONS_FORM]
    assert [r['analysis'] for r in told_rows] == [told.strip()]
    assert len(told_rows[0]['analysis']) <= JOB_ANALYSIS_MAX_CHARS
    assert finished['report']['plan']['documents'] == list(reversed(ids))
    r = runner(job)
    assert r.plan(job)['documents'] == list(reversed(ids))
    assert r.plan(job)['piece_instructions'] == told.strip()
    assert model.seen['plan'] == 1


def test_a_planner_that_overshoots_the_cap_plans_at_once_with_its_instructions_cut(monkeypatch):
    """BRIEF PF (A): a planner that restated a guideline in piece_instructions
    was refused 18 times and the job fell back to a default plan. Now its
    first plan_work is kept, the instructions cut at a whole sentence within
    the cap, the plan says they were cut, and every piece is told what was
    kept."""
    from plaid_agent.core.limits import JOB_PIECE_INSTRUCTIONS_MAX_CHARS as cap
    client = JobClient(_docs(1))
    job = start(client, 'Fill the thematic role of every word.', id=J, plan=None)
    told = ' '.join(f'Rule {i}: a subject of a transitive verb is the agent.' for i in range(120))
    assert len(told) > cap
    model = use(monkeypatch, _model(plan={'pieces': 'sentences', 'piece_instructions': told}, piece=_gloss_all))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    planning = [c for c in model.calls if _kind(c['asked']) == 'plan']
    assert len(planning) == 2, 'one plan_work, then its one-line reply'
    kept = told[:cap].rsplit('. ', 1)[0] + '.'
    assert finished['report']['plan']['by'] == 'model'
    assert finished['report']['plan']['piece_instructions'] == kept
    assert finished['report']['plan']['instructions_cut'] == len(told)
    assert _plan_rows(client)[0]['instructions_cut'] == len(told)
    pieces = [c['asked'] for c in model.calls if _kind(c['asked']) == 'piece' and c['n'] == 1]
    assert pieces and all(f'How to do every piece, as the job was planned:\n{kept}\n' in p for p in pieces)


# --- pieces of a document and of the selection ---------------------------------------------

def test_a_document_piece_sees_the_whole_document_once(monkeypatch):
    client = JobClient(_docs(2))
    job = start(client, 'Summarise each text.', id=J, plan='document')
    model = use(monkeypatch, _model(piece=lambda asked, n: reply('Story about ka and ta.')))
    finished = run_job(job, runner(job))
    pieces = [c['asked'] for c in model.calls if c['n'] == 1]
    assert len(pieces) == 2 and all(p.splitlines()[-1].startswith('Your piece: the whole document') for p in pieces)
    assert [n['note'] for n in finished['report']['notes']] == ['Story about ka and ta.'] * 2
    assert {n['name'] for n in finished['report']['notes']} == {'Story 1', 'Story 2'}


def test_a_document_too_large_for_one_piece_is_worked_in_stretches_and_the_report_says_so(monkeypatch):
    monkeypatch.setattr(igt_job, 'JOB_DOCUMENT_PIECE_MAX_CHARS', 10)
    client = JobClient(_docs(1))
    job = start(client, 'Summarise each text.', id=J, plan='document')
    model = use(monkeypatch, _model(piece=_gloss_all))
    finished = run_job(job, runner(job))
    assert all(not c['asked'].splitlines()[-1].startswith('Your piece: the whole') for c in model.calls)
    assert finished['report']['plan']['fallback'] == [{'document_id': 'd1', 'reason': 'too-long'}]


GLOSSED = [{'words': [('ka', [('ka', 'go')], 'human'), ('ta', [('ta', 'go')], 'human')], 'translation': ('T.', 'human')},
           {'words': [('sa', [('sa', 'go')], 'human')], 'translation': ('S.', 'human')}]


@pytest.mark.parametrize('pieces', ['document', 'selection'])
def test_a_document_too_long_for_one_piece_is_worked_in_stretches_over_every_sentence(monkeypatch, pieces):
    """REV-JG-7: a check job planned by documents (or as one selection that
    fell back), whose long document has nothing empty. Its stretches cover
    every sentence, so the instructions are carried out on the whole text."""
    monkeypatch.setattr(igt_job, 'JOB_DOCUMENT_PIECE_MAX_CHARS', 10)
    client = JobClient({'d1': document('d1', 'Story 1', GLOSSED)})
    job = start(client, 'Check every gloss and propose corrections.', id=J, plan=pieces)
    if pieces == 'selection':
        # The selection's one piece failed: each document is worked alone.
        runner(job).fall_back(igt_job.SELECTION, 'failed')
    model = use(monkeypatch, _model(piece=lambda asked, n: reply('Checked.')))
    finished = run_job(job, runner(job))
    named = [c['asked'].splitlines()[-1] for c in model.calls if c['n'] == 1 and _kind(c['asked']) == 'piece']
    assert named == ['Your piece: s1, s2.'], named
    assert finished['report']['documents'][0]['state'] == 'done'


def test_a_sentences_plan_walks_every_sentence_of_a_fully_analysed_document(monkeypatch):
    """BRIEF EW: a job filling a new field, or checking glosses, on texts
    already analysed. A plan in sentences without only_empty walks every
    sentence, and each piece reads its sentences as analysed. A piece that
    stages nothing ends its sentences worked, with nothing left blank."""
    client = JobClient({'d1': document('d1', 'Story 1', GLOSSED)})
    job = start(client, 'Check every gloss and correct the wrong ones.', id=J, plan='sentences')
    model = use(monkeypatch, _model(piece=lambda asked, n: reply('Checked.')))
    finished = run_job(job, runner(job))
    pieces = [c['asked'] for c in model.calls if _kind(c['asked']) == 'piece' and c['n'] == 1]
    assert [p.splitlines()[-1] for p in pieces] == ['Your piece: s1, s2.']
    assert 'Empty in' not in pieces[0]
    assert 'Nothing empty in s1, s2 of what this job fills.' in pieces[0]
    (doc,) = finished['report']['documents']
    assert doc['state'] == 'done' and doc['done'] == doc['targets'] == 2 and not doc['skipped']
    assert doc['left'] == [] and not doc['counts'].get('left') and not doc['counts'].get('not_reached')


HALF = [GLOSSED[0], {'words': ['sa'], 'translation': ('S.', 'human')}, GLOSSED[1]]


@pytest.mark.parametrize('only', [False, True], ids=['every-sentence', 'skip-analyzed'])
def test_a_sentences_plan_that_skips_filled_sentences_walks_only_sentences_with_something_empty(monkeypatch, only):
    """plan_work's skip_filled_sentences (BRIEF EW, which reversed
    BRIEF-JH item 6's every_sentence, named so by BRIEF OE): for instructions
    that only fill words nobody analysed or empty translations. Its plan row
    keeps it as only_empty only when true. Then
    only s2, the sentence with a blank word, is worked, as a plan in
    sentences did before. Without it every sentence is."""
    client = JobClient({'d1': document('d1', 'Story 1', HALF)})
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan=None)
    model = use(monkeypatch, _model(plan={'pieces': 'sentences', 'fills': ['segmentation', 'Morph Gloss'],
                                          'skip_filled_sentences': only},
                                    piece=lambda asked, n: reply('Checked.')))
    finished = run_job(job, runner(job))
    rows = _plan_rows(client)
    assert rows[0].get('only_empty') is (True if only else None) and 'every_sentence' not in rows[0]
    assert finished['report']['plan'].get('only_empty') is (True if only else None)
    pieces = [c['asked'] for c in model.calls if _kind(c['asked']) == 'piece' and c['n'] == 1]
    assert [p.splitlines()[-1] for p in pieces] == (['Your piece: s2. s1 is context.'] if only
                                                    else ['Your piece: s1, s2, s3.'])
    assert 'Empty in s2: segmentation and Morph Gloss in w1 "sa".' in pieces[0]
    (doc,) = finished['report']['documents']
    assert doc['state'] == 'done' and doc['done'] == doc['targets'] == (1 if only else 3)


def test_skip_filled_sentences_means_nothing_under_a_plan_by_documents(monkeypatch):
    """skip_filled_sentences is a plan in sentences' only: plan_work keeps it on no
    other, and a plan by documents walks every sentence."""
    client = JobClient({'d1': document('d1', 'Story 1', GLOSSED)})
    job = start(client, 'Check every gloss.', id=J, plan=None)
    model = use(monkeypatch, _model(plan={'pieces': 'document', 'skip_filled_sentences': True},
                                    piece=lambda asked, n: reply('Checked.')))
    run_job(job, runner(job))
    assert 'only_empty' not in _plan_rows(client)[0]
    assert [c['asked'].splitlines()[-1] for c in model.calls if _kind(c['asked']) == 'piece' and c['n'] == 1] == [
        'Your piece: the whole document "Story 1", 2 sentences.']


def test_a_selection_is_one_piece_whose_writes_land_document_by_document(monkeypatch):
    client = JobClient(_docs(2))
    job = start(client, 'Gloss ka in every text.', id=J, plan='selection')
    written = []
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        written.append(sorted(o.get('word_id') for o in ops if o.get('kind') == 'set_analysis'))
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def piece(asked, n):
        if n == 1:
            return reply(calls=[call(9, 'read_sentences', {'items': [{'document': f'Story {i}', 'sentences': [1, 2]}
                                                                     for i in (1, 2)]})])
        if n == 2:
            return reply(calls=[call(1, 'set_analysis', {'document': f'Story {i}', 'ref': 's1.w1',
                                                         'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]})
                                for i in (1, 2)])
        return reply('Glossed ka in both texts.')
    model = use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert len([c for c in model.calls if c['n'] == 1]) == 1, 'one context for the whole selection'
    assert written == [['d1-s1w1'], ['d2-s1w1']]
    assert [d['state'] for d in finished['report']['documents']] == ['done', 'done']
    assert finished['report']['notes'][0]['note'] == 'Glossed ka in both texts.'


def _lexicon_takes_creates(monkeypatch, client):
    """The fake's lexicon holds what the job's writes create, as core's
    does: each entry a write created is in the next read of the lexicon."""
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        before = len(client.calls)
        out = real(c, ops, **kw)
        for kind, p in client.calls[before:]:
            if kind == 'vocab_items.create':
                vocab_id, form, metadata = (list(p['args']) + [None])[:3]
                client._lexicon['items'].append({'id': p['kwargs']['id'], 'form': form,
                                                 'metadata': metadata or p['kwargs'].get('metadata') or {}})
        return out
    monkeypatch.setattr(igt_job, 'execute_plan', execute)


@pytest.mark.parametrize('first', ['Story 1', 'Story 2'])
def test_a_selection_that_links_one_new_entry_in_two_documents_creates_it_once(monkeypatch, first):
    """REV-JG2-2: the selection makes one entry and links it in both
    documents, the links staged in either order. The entry is created with
    the first document written that links it, and the other document's link
    names the entry made: the job ends done, one entry, both linked."""
    client = JobClient(_docs(2))
    _lexicon_takes_creates(monkeypatch, client)
    job = start(client, 'Gloss and link every word nobody analysed.', id=J, plan='selection')

    def piece(asked, n):
        if n == 1:
            return reply(calls=[
                call(1, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1',
                                         'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]}),
                call(2, 'set_analysis', {'document': 'Story 2', 'ref': 's1.w1',
                                         'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]}),
                call(3, 'create_entry', {'form': 'ka', 'fields': {'gloss': 'go'}})])
        if n == 2:
            names = [first] + [x for x in ('Story 1', 'Story 2') if x != first]
            return reply(calls=[call(4 + i, 'link_entry', {'document': d, 'refs': ['s1.w1.m1'],
                                                           'entry_id': 'new:v1:ka#1'}) for i, d in enumerate(names)])
        return reply('Glossed ka in both texts and linked it.')
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    made = [p['kwargs']['id'] for k, p in client.calls if k == 'vocab_items.create']
    assert len(made) == 1, made
    links = [p for k, p in client.calls if k == 'vocab_links.create']
    assert len(links) == 2 and all(made[0] in (list(p['args']) + list(p['kwargs'].values())) for p in links), links
    assert [d['state'] for d in finished['report']['documents']] == ['done', 'done']
    assert [e['id'] for e in finished['report']['entries']['created']] == made


def test_a_selections_second_document_links_an_entry_that_fits_and_creates_none(monkeypatch):
    """The entry the selection staged exists already when its second
    document is written, the job's own (made by the first document's write
    before a passing error): no entry is created where one fits, at the
    write as at staging, and the link names the one there. Someone else's
    entry made meanwhile is never linked unasked (test_job_entry_gone)."""
    client = JobClient(_docs(2))
    _lexicon_takes_creates(monkeypatch, client)
    job = start(client, 'Gloss and link every word nobody analysed.', id=J, plan='selection')
    real = igt_job.IgtRunner.write_piece

    def write_piece(self, project, d, *a, **kw):
        if d == 'd2':
            from job_fixtures import stamp
            client._lexicon['items'].append({'id': 'e-made', 'form': 'ka', 'metadata': {'gloss': 'go', **stamp(J)}})
        return real(self, project, d, *a, **kw)
    monkeypatch.setattr(igt_job.IgtRunner, 'write_piece', write_piece)

    def piece(asked, n):
        if n == 1:
            return reply(calls=[
                call(1, 'set_analysis', {'document': 'Story 2', 'ref': 's1.w1',
                                         'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]}),
                call(2, 'create_entry', {'form': 'ka', 'fields': {'gloss': 'go'}})])
        if n == 2:
            return reply(calls=[call(3, 'link_entry', {'document': 'Story 2', 'refs': ['s1.w1.m1'],
                                                       'entry_id': 'new:v1:ka#1'})])
        return reply('Glossed ka and linked it.')
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done', (finished.get('reason'), job.status.get('message'))
    assert not [p for k, p in client.calls if k == 'vocab_items.create']
    links = [p for k, p in client.calls if k == 'vocab_links.create']
    assert len(links) == 1 and 'e-made' in str(links), links


def test_a_document_the_selection_never_read_is_worked_as_a_piece_of_its_own(monkeypatch):
    """REV-JG2-5: the selection's model reads Story 1 and never Story 2 (its
    budget ran out, say). Story 2 is not recorded as worked: the walk works
    it as a piece of its own, and the report's plan says it was worked apart
    from the selection (``not-read``)."""
    client = JobClient(_docs(2))
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan='selection')
    alone, written = [], []
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        written.extend(o.get('word_id') for o in ops if o.get('kind') == 'set_analysis')
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def piece(asked, n):
        if '"Story 1"' in asked and '"Story 2"' in asked:
            if n == 1:
                return reply(calls=[call(9, 'read_document', {'document': 'Story 1'})])
            if n == 2:
                return reply(calls=[call(1, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1', 'morphemes': [
                    {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]})])
            return reply('Glossed ka in Story 1, and ran out of time.')
        if n == 1:
            alone.append(asked.split('"')[1])
        return _gloss_all(asked, n)
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert 'Story 2' in alone, 'Story 2 was never given to a model'
    plan = finished['report']['plan']
    assert {'document_id': 'd2', 'reason': 'not-read'} in plan['fallback'], plan
    assert {'document_id': 'd1', 'reason': 'not-read'} not in plan['fallback']
    assert sorted(w for w in written if w.startswith('d2')) == ['d2-s1w1', 'd2-s1w2', 'd2-s2w1'], written
    assert [d['state'] for d in finished['report']['documents']] == ['done', 'done']


def test_a_document_the_selection_read_in_part_is_worked_where_it_was_not_shown(monkeypatch):
    """REV-JG3-1: what the selection read is what a read printed to the
    model, never what a tool loaded. Its model reads s1 of Story 1 alone,
    glosses ka there and runs out of time. Story 1's s2 was never shown: the
    walk works it as a piece of its own, and the report's plan says Story 1
    was worked apart in part (``not-read``)."""
    client = JobClient(_docs(2))
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan='selection')
    alone = []

    def piece(asked, n):
        if '"Story 1"' in asked and '"Story 2"' in asked:
            if n == 1:
                return reply(calls=[call(1, 'read_document', {'document': 'Story 1', 'from_sentence': 1,
                                                              'to_sentence': 1})])
            if n == 2:
                return reply(calls=[call(2, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1', 'morphemes': [
                    {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]})])
            return reply('Glossed ka in Story 1 and ran out of time.')
        if n == 1:
            alone.append((asked.split('"')[1], re.search(r'Your piece: ([^.]*)\.', asked).group(1)))
        return _gloss_all(asked, n)
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    assert ('Story 1', 's2') in alone, alone
    assert {'document_id': 'd1', 'reason': 'not-read'} in finished['report']['plan']['fallback']


def test_a_selection_that_was_shown_every_sentence_of_a_text_works_it_whole(monkeypatch):
    """The guard: a text whose every sentence a read printed is the
    selection's, and no piece of its own works it again."""
    client = JobClient(_docs(1))
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan='selection')
    alone = []

    def piece(asked, n):
        if 'Your piece: the whole selection above.' in asked:
            if n == 1:
                return reply(calls=[call(1, 'read_sentences', {'items': [{'document': 'Story 1',
                                                                          'sentences': ['s1', 's2']}]})])
            if n == 2:
                return reply(calls=[call(2, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1', 'morphemes': [
                    {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]})])
            return reply('Glossed ka, and left the rest.')
        alone.append(asked)
        return reply('Nothing.')
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done' and not alone
    assert finished['report']['plan']['fallback'] == []


def test_a_document_piece_shows_every_sentence_of_its_document(monkeypatch):
    """A whole document is handed to its piece whole, past a read's cap of
    sentences (MAX_SENTENCES_PER_READ): its piece says the whole document,
    and the model is shown all of it."""
    from plaid_agent.core.limits import MAX_SENTENCES_PER_READ
    n = MAX_SENTENCES_PER_READ + 5
    client = JobClient({'d1': document('d1', 'Story 1', [{'words': [f'w{i}']} for i in range(1, n + 1)])})
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan='document')
    model = use(monkeypatch, _model(piece=lambda asked, k: reply('Nothing.')))
    run_job(job, runner(job))
    first = next(c['asked'] for c in model.calls if c['n'] == 1 and 'Your piece: the whole document' in c['asked'])
    assert f'Your piece: the whole document "Story 1", {n} sentences.' in first
    assert f'[s{n}] w{n}.' in first.splitlines(), 'the last sentence is shown'


def test_a_document_the_selection_never_read_is_not_reached_when_the_job_stops_first(monkeypatch):
    """The same, the job stopped once the selection is written: Story 2 ends
    not reached, never done."""
    client = JobClient(_docs(2))
    job = start(client, 'Gloss every word nobody analysed.', id=J, plan='selection')
    real = igt_job.IgtRunner.selection

    def selection(self, job_, order):
        out = real(self, job_, order)
        client.jobs.cancel(job_.id)
        job_.beat()
        return out
    monkeypatch.setattr(igt_job.IgtRunner, 'selection', selection)

    def piece(asked, n):
        if n == 1 and '"Story 2"' in asked and '"Story 1"' in asked:
            return reply(calls=[call(1, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1', 'morphemes': [
                {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]})])
        return reply('Done.')
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    states = {d['document_id']: d['state'] for d in finished['report']['documents']}
    assert states['d2'] == 'not-reached', states


def _fails_once(real):
    from plaid_client import PlaidAPIError
    failed = []

    def call_(*a, **kw):
        if not failed:
            failed.append(1)
            raise PlaidAPIError('HTTP 502', status=502)
        return real(*a, **kw)
    return call_


def test_a_fallback_core_fails_once_is_kept_and_read_when_tried_again():
    """A fallback row whose call core fails is written when the call is made
    again, and a read of the fallbacks core fails is read again: neither is
    taken for done (the selection's put-off rows go through through_core)."""
    from plaid_agent.core.job import through_core
    client = JobClient(_docs(1))
    job = start(client, id=J, plan='selection')
    r = runner(job)
    client.jobs.add_decisions = _fails_once(client.jobs.add_decisions)
    through_core(job, lambda: r.fall_back('d1', 'not-read'))
    assert [f for (f, _k) in client.jobs.decision_rows[J] if f == ' fallback d1']
    again = runner(job)
    client.jobs.decisions = _fails_once(client.jobs.decisions)
    assert through_core(job, again.fallen_back) == {'d1': 'not-read'}


@pytest.mark.parametrize('pieces', ['sentences', 'document', 'selection'])
def test_a_change_in_a_document_outside_the_job_is_proposed_and_listed(monkeypatch, pieces):
    """REV-JG-6: a piece stages in a document of the project the job does
    not hold. The job may not write there: the change is a proposed change,
    listed in the report and counted, whatever the plan cut, and the
    document is untouched."""
    docs = _docs(2)
    client = JobClient(docs)
    job = start(client, 'Gloss every word nobody analysed.', documents=['d1'], id=J, plan=pieces)
    written = []
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        written.extend(o.get('word_id') for o in ops)
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def piece(asked, n):
        if n == 1:
            return reply(calls=[call(1, 'set_analysis', {'document': 'Story 2', 'ref': 's1.w1',
                                                         'morphemes': [{'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]})])
        return reply('Glossed ka in Story 2.')
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    report = finished['report']
    assert 'd2-s1w1' not in written, 'nothing is written outside the job'
    changes = [(c['document_id'], c['ref'], c['kind']) for c in report['proposed']]
    assert ('d2', 's1.w1', 'set_analysis') in changes, report['proposed']
    assert report['totals']['proposed'] >= 1


@pytest.mark.skipif(sandbox.available() is not None, reason='the code sandbox is not installed')
def test_a_selections_code_makes_a_table_kept_as_data_in_the_report(monkeypatch):
    client = JobClient(_docs(2))
    job = start(client, 'Report inconsistent glosses across these texts.', id=J, plan='selection')
    code = ('rows = [[d["name"], len(load(d["id"])["sentences"])] for d in documents()]\n'
            'print(table("Sentences per text", ["text", "sentences"], rows))')

    def piece(asked, n):
        if 'Your piece: the whole selection above.' not in asked:
            return reply('Nothing to do here.')
        if n == 1:
            return reply(calls=[call(1, 'run_code', {'code': code})])
        return reply('Counted the sentences.')
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert finished['report']['tables'] == [{'title': 'Sentences per text', 'columns': ['text', 'sentences'],
                                             'rows': [['Story 1', 2], ['Story 2', 2]], 'more': 0}]


@pytest.mark.skipif(sandbox.available() is not None, reason='the code sandbox is not installed')
def test_a_job_that_only_made_a_table_keeps_the_assistants_summary(monkeypatch):
    """BRIEF PF follow-up: a job whose work is to read and report wrote and
    proposed nothing but made a table. Its summary is the final context's,
    not the worker's line."""
    client = JobClient(_docs(2))
    job = start(client, 'Report how long each text is.', id=J, plan='selection')
    code = ('rows = [[d["name"], len(load(d["id"])["sentences"])] for d in documents()]\n'
            'print(table("Sentences per text", ["text", "sentences"], rows))')

    def piece(asked, n):
        if 'Your piece: the whole selection above.' not in asked:
            return reply('Nothing to do here.')
        if n == 1:
            return reply(calls=[call(1, 'run_code', {'code': code})])
        return reply('Counted the sentences.')
    model = use(monkeypatch, _model(piece=piece, summary='Both texts have two sentences.'))
    finished = run_job(job, runner(job, write_summary=True))
    report = finished['report']
    assert report['totals']['changes'] == 0 and report['totals']['proposed'] == 0 and report['tables']
    assert model.seen['summary'] == 1
    assert report['summary'] == 'Both texts have two sentences.' and report['summary_by'] == 'model'


def test_the_fixed_line_is_only_for_a_job_that_wrote_proposed_and_made_nothing():
    from plaid_agent.core.job import wrote_nothing
    empty = {'totals': {'changes': 0, 'proposed': 0}, 'harmonize': {'changed': [], 'changed_more': 0},
             'tables': [], 'tables_more': 0}
    assert wrote_nothing(empty)
    assert not wrote_nothing({**empty, 'tables': [{'title': 'T', 'columns': [], 'rows': [], 'more': 0}]})
    assert not wrote_nothing({**empty, 'tables_more': 1}), 'a table the report could not hold is a table made'
    assert not wrote_nothing({**empty, 'totals': {'changes': 1, 'proposed': 0}})
    assert not wrote_nothing({**empty, 'totals': {'changes': 0, 'proposed': 2}})


@pytest.mark.skipif(sandbox.available() is not None, reason='the code sandbox is not installed')
def test_code_in_a_piece_writes_only_through_the_plan(monkeypatch):
    """How the sandbox guarantees it: code runs in a monty worker with no
    filesystem and no network, and reaches the project only through the
    host functions lent to it, none of which is a client. Its one way to
    change anything is plan(), which stages through the workspace's guards
    like a plan tool. Nothing is written while the model works: the job's
    apply rule writes after the piece ends."""
    from plaid_agent.igt.sandbox import api
    from plaid_agent.igt.job import JobWorkspace
    from plaid_agent.igt.project import load_project
    client = JobClient(_docs(1))
    ws = JobWorkspace(client, load_project(client, 'p1'))
    lent = api(ws)
    # The project's reads, plan(), table(), and the conversation's files
    # (none in a job): nothing else.
    assert {'documents', 'load', 'query', 'plan', 'lexicon', 'recording', 'table'} <= set(lent)
    assert set(lent) - {'documents', 'load', 'query', 'plan', 'lexicon', 'recording', 'table'} <= {
        'files', 'read_file', 'file_rows', 'save_file'}, sorted(lent)
    assert not any(hasattr(f, 'client') or getattr(f, '__self__', None) is client for f in lent.values())
    job = start(client, 'Gloss ka.', id=J, plan='sentences')
    seen_writes = []
    code = 'print(plan("set_analysis", document="Story 1", ref="s1.w1", morphemes=[{"form": "ka"}]))'

    def piece(asked, n):
        if n == 1:
            return reply(calls=[call(1, 'run_code', {'code': code})])
        seen_writes.append([k for k, _ in client.calls if k.startswith(('tokens.', 'spans.', 'vocab_'))])
        return reply('Staged ka through code.')
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert seen_writes == [[]], 'nothing written while the piece ran'
    assert finished['report']['totals']['words'] >= 0
    assert [k for k, _ in client.calls if k.startswith('tokens.')], 'written after it ended, by the rule'


# --- the final context ------------------------------------------------------------------

def test_the_summary_is_given_the_reports_own_sections(monkeypatch):
    client = JobClient(_docs(1))
    job = start(client, id=J)
    model = use(monkeypatch, _model(piece=_gloss_all))
    finished = run_job(job, runner(job, write_summary=True))
    (asked,) = [c['asked'] for c in model.calls if _kind(c['asked']) == 'summary']
    # BRIEF PF: what the job wrote, as the worker counted it, comes first.
    assert asked.startswith('This job wrote 3 changes in 2 of 2 sentences.\nOf what it fills: segmentation left blank 0 '
                            'words, Morph Gloss left blank 0 morphemes.\n\nThe job\'s instructions:\nSegment and '
                            'gloss'), asked
    assert 'Changes proposed for a person to approve: 0.' in asked and 'Glossed every blank word' in asked
    assert model.calls[-1]['kwargs'].get('tools') in (None, []), 'no tools'
    assert finished['report']['summary'] == 'The job glossed the words it was asked to.'
    assert finished['report']['summary_by'] == 'model'


def test_a_job_that_wrote_and_proposed_nothing_gets_a_fixed_summary_and_no_final_context(monkeypatch):
    """BRIEF PF (B): a job that wrote nothing was summarised by the model as
    having filled a field. Now the worker writes the summary, one fixed
    sentence, and the final context is not asked."""
    client = JobClient(_docs(1))
    job = start(client, id=J)
    model = use(monkeypatch, _model(summary='The job filled the thematic field, sentence by sentence.'))
    finished = run_job(job, runner(job, write_summary=True))
    assert finished['state'] == 'done' and finished['report']['totals']['changes'] == 0
    assert model.seen['summary'] == 0, 'the final context is not asked'
    assert finished['report']['summary'] == 'The job wrote no change and proposed none.'
    assert finished['report']['summary_by'] == 'worker' and finished['report']['summary_failed'] is False


def test_a_job_that_only_proposed_changes_is_summarised_by_the_model(monkeypatch):
    """A proposed change is something for a person to read about: the final
    context writes the summary."""
    client = JobClient(_docs(1))
    job = start(client, id=J)

    def piece(asked, n):
        if n == 1:
            return reply(calls=[call(1, 'guidelines', {'action': 'help'})])
        if n == 2:
            return reply(calls=[call(2, 'guidelines', {'action': 'add', 'title': 'Ka', 'body': 'Gloss ka as go.'})])
        return reply('Proposed a guideline.')
    model = use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job, write_summary=True))
    assert finished['report']['totals']['changes'] == 0 and finished['report']['totals']['proposed'] >= 1, \
        finished['report']['totals']
    assert model.seen['summary'] == 1
    assert finished['report']['summary_by'] == 'model'


def test_a_summary_that_cannot_be_written_leaves_the_report_without_prose(monkeypatch):
    client = JobClient(_docs(1))
    job = start(client, id=J)
    use(monkeypatch, _model(piece=_gloss_all, summary=RuntimeError('the model fell over')))
    finished = run_job(job, runner(job, write_summary=True))
    assert finished['state'] == 'done'
    assert finished['report']['summary'] is None and finished['report']['summary_failed'] is True


def test_core_failing_a_call_of_the_final_context_once_still_writes_its_prose(monkeypatch):
    """REV-JG2-3's sweep: the final context's reads go through the same
    helper as every other call, so one 502 there does not cost the report
    its prose."""
    from plaid_client import PlaidAPIError
    client = JobClient(_docs(1))
    job = start(client, id=J)
    use(monkeypatch, _model(piece=_gloss_all))
    r = runner(job, write_summary=True)
    real, failed = r.summarize, []

    def summarize(job_, report):
        if not failed:
            failed.append(1)
            raise PlaidAPIError('HTTP 502', status=502)
        return real(job_, report)
    r.summarize = summarize
    finished = run_job(job, r)
    assert finished['report']['summary'] == 'The job glossed the words it was asked to.'
    assert finished['report']['summary_failed'] is False


def test_a_crash_before_the_final_context_writes_it_when_the_job_resumes(monkeypatch):
    client = JobClient(_docs(1))
    job = start(client, id=J)
    use(monkeypatch, _model(piece=_gloss_all))
    r = runner(job, write_summary=True)

    class Crash(BaseException):
        pass

    def crash(j, report):
        raise Crash()
    r.summarize = crash
    with pytest.raises(Crash):
        run_job(job, r)
    assert job.status['phase'] == 'reporting'
    model = use(monkeypatch, _model(piece=_gloss_all, summary='Written on the second run.'))
    finished = run_job(job, runner(job, write_summary=True))
    assert not [c for c in model.calls if _kind(c['asked']) == 'piece'], 'no piece again'
    assert finished['report']['summary'] == 'Written on the second run.'


def test_a_stopped_job_writes_no_prose(monkeypatch):
    client = JobClient(_docs(1))
    job = start(client, id=J)
    model = use(monkeypatch, _model(piece=_gloss_all))
    r = runner(job, write_summary=True)
    r.work = lambda j: (client.jobs.cancel(j.id), j.beat())
    finished = run_job(job, r)
    assert finished['state'] == 'cancelled' and finished['report']['summary'] is None
    assert not [c for c in model.calls if _kind(c['asked']) == 'summary']


# --- a selection's lexicon changes and its put-off documents (REV-JH-2) -------------------

def _lexicon_selection(monkeypatch, put_off):
    """A selection that glosses ka in both texts and changes the gloss of
    the entry gam, the documents in ``put_off`` in use at its write. The
    kinds each write sent, and the finished job."""
    client = JobClient(_docs(2))
    job = start(client, 'Gloss ka in every text and gloss the entry gam as fish-net.', id=J, plan='selection')
    sent = []
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        sent.append(sorted(o['kind'] for o in ops))
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)
    r = runner(job)
    real_hold, held = r.hold, set()

    def hold(c, document_id):
        if document_id in put_off and document_id not in held:
            held.add(document_id)
            raise igt_job.Deferred(document_id)  # someone edits it right now
        return real_hold(c, document_id)
    r.hold = hold

    def piece(asked, n):
        if 'Your piece: the whole selection above.' not in asked:
            return reply('Nothing left to do here.')
        if n == 1:
            return reply(calls=[call(9, 'read_sentences', {'items': [{'document': f'Story {i}', 'sentences': [1, 2]}
                                                                     for i in (1, 2)]})])
        if n == 2:
            return reply(calls=[call(i, 'set_analysis', {'document': f'Story {i}', 'ref': 's1.w1', 'morphemes': [
                {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]}) for i in (1, 2)] + [
                call(3, 'set_entry_field', {'entry_id': 'vi-gam', 'field': 'gloss', 'value': 'fish-net'})])
        return reply('Glossed ka in both texts and changed the gloss of gam.')
    use(monkeypatch, _model(piece=piece))
    return sent, run_job(job, r)


def test_a_selections_lexicon_change_goes_with_the_next_write_when_its_first_document_is_put_off(monkeypatch):
    """REV-JH-2: Story 1, whose write would carry the lexicon change, is in
    use. The change goes with Story 2's write, and nothing is proposed."""
    sent, finished = _lexicon_selection(monkeypatch, {'d1'})
    assert finished['state'] == 'done'
    assert sent[0] == ['set_analysis', 'set_entry_field'], sent
    assert sum('set_entry_field' in b for b in sent) == 1, sent
    assert not finished['report'].get('proposed')


def test_a_selections_lexicon_change_no_write_carries_is_proposed(monkeypatch):
    """Every document of the selection is in use at its write: no write
    carries the lexicon change, which is listed as a proposed change."""
    sent, finished = _lexicon_selection(monkeypatch, {'d1', 'd2'})
    assert finished['state'] == 'done'
    assert not any('set_entry_field' in b for b in sent), sent
    proposed = finished['report'].get('proposed') or []
    assert [p['kind'] for p in proposed] == ['set_entry_field'], proposed


# --- a write that failed: what landed is known (REV-JSF-3, BRIEF RX) -------------------------

def _lexicon_selection_batches(monkeypatch, answers):
    """The selection of ``_lexicon_selection``: Story 1's write carries the
    lexicon change in its one request (a try), the n-th request answered as
    ``answers`` says (``refused``: core refuses it, 409, ``lost``: it lands
    and its answer is lost, ``unsent``: its answer is lost and it never
    landed, a proxy's 502 either way), the rest landing. The kinds each
    write sent, the kinds and fate of each request, and the finished job."""
    from plaid_client import PlaidAPIError
    client = JobClient(_docs(2))
    job = start(client, 'Gloss ka in every text and gloss the entry gam as fish-net.', id=J, plan='selection')
    from plaid_client import testing
    real_submit, batches = testing._Batch.submit, []

    def submit(self):
        fate = answers.get(len(batches) + 1, 'landed')
        batches.append((sorted({k for k, _ in self.queued}), fate))
        if fate in ('refused', 'unsent'):
            self.open = False
            raise PlaidAPIError(f'HTTP {409 if fate == "refused" else 502}', status=409 if fate == 'refused' else 502,
                                method='POST')
        out = real_submit(self)
        if fate == 'lost':
            raise PlaidAPIError('HTTP 502', status=502, method='POST')
        return out
    monkeypatch.setattr(testing._Batch, 'submit', submit)
    sent = []
    real = igt_job.execute_plan

    def execute(c, ops, **kw):
        sent.append(sorted(o['kind'] for o in ops))
        return real(c, ops, **kw)
    monkeypatch.setattr(igt_job, 'execute_plan', execute)

    def piece(asked, n):
        if 'Your piece: the whole selection above.' not in asked:
            return reply('Nothing left to do here.')
        if n == 1:
            return reply(calls=[call(9, 'read_sentences', {'items': [{'document': f'Story {i}', 'sentences': [1, 2]}
                                                                     for i in (1, 2)]})])
        if n == 2:
            return reply(calls=[call(i, 'set_analysis', {'document': f'Story {i}', 'ref': 's1.w1', 'morphemes': [
                {'form': 'ka', 'fields': {'Morph Gloss': 'go'}}]}) for i in (1, 2)] + [
                call(3, 'set_entry_field', {'entry_id': 'vi-gam', 'field': 'gloss', 'value': 'fish-net'})])
        return reply('Glossed ka in both texts and changed the gloss of gam.')
    use(monkeypatch, _model(piece=piece))
    return sent, batches, run_job(job, runner(job))


STORY1 = ['spans.create', 'tokens.create', 'vocab_items.patch_metadata']


def test_a_selections_lexicon_change_in_a_write_that_never_landed_goes_with_the_next_write(monkeypatch):
    """REV-JSF-3: core refuses Story 1's request twice (the starter's own
    browser wrote, 409): nothing of it landed, Story 1 is put off, and the
    lexicon change it carried goes with Story 2's write: written once."""
    sent, batches, finished = _lexicon_selection_batches(monkeypatch, {1: 'refused', 2: 'refused'})
    assert finished['state'] == 'done'
    assert batches[:2] == [(STORY1, 'refused')] * 2
    assert sent[2] == ['set_analysis', 'set_entry_field'], f'Story 2 carries it: {sent}'
    assert [b for b, fate in batches if fate == 'landed' and 'vocab_items.patch_metadata' in b] == [STORY1]
    assert not finished['report'].get('proposed')


def test_a_selections_lexicon_change_in_a_write_whose_answer_was_lost_is_never_sent_again(monkeypatch):
    """Story 1's request lands and its answer is lost. The write taken
    again from the gate asks core: it landed, so nothing of it is sent
    again, Story 2's write does not carry the change, and nothing is
    listed."""
    sent, batches, finished = _lexicon_selection_batches(monkeypatch, {1: 'lost'})
    assert finished['state'] == 'done'
    assert batches[0] == (STORY1, 'lost')
    assert sum('vocab_items.patch_metadata' in b for b, _ in batches) == 1, batches
    assert sent[1:] == [['set_analysis']], f'Story 2 alone: {sent}'
    assert not finished['report'].get('proposed')
    assert finished['report']['totals']['repeated'] == 2, 'its analysis and the change, left out when sent again'


def test_a_selections_lexicon_change_in_a_write_whose_answer_was_lost_unlanded_is_sent_once(monkeypatch):
    """Story 1's answer is lost and the request never landed: taken again
    from the gate, core says so, and the same write is sent again (refused
    twice then, 409): Story 1 is put off and Story 2's write carries the
    change, written once."""
    sent, batches, finished = _lexicon_selection_batches(monkeypatch, {1: 'unsent', 2: 'refused', 3: 'refused'})
    assert finished['state'] == 'done'
    assert batches[0] == (STORY1, 'unsent')
    assert [b for b, fate in batches if fate == 'landed' and 'vocab_items.patch_metadata' in b] == [STORY1]
    assert not finished['report'].get('proposed')


def test_the_planners_document_line_names_only_what_is_empty_the_most_first_and_counts_the_rest():
    """DF1 open point 3: a project with many fields made long lines. A line
    names the targets with something empty, most first, at most
    JOB_PLAN_EMPTY_TARGETS, then how many more; a document with nothing empty
    says so."""
    from plaid_agent.core.limits import JOB_PLAN_EMPTY_TARGETS
    from plaid_agent.igt import targets as tg
    from plaid_agent.igt.project import load_project
    client = JobClient({'d1': document('d1', 'Story 1', [{'words': ['ka']}])})
    job = start(client)
    r = runner(job)
    project = load_project(client, 'p1')
    ids = [t.id for t in tg.fillable(project)]
    many = {i: n for i, n in zip(ids, [2, 9, 0, 4])}
    facts = [{'name': 'A', 'sentences': 1, 'words': 1, 'characters': 2, 'empty': many},
             {'name': 'B', 'sentences': 1, 'words': 1, 'characters': 2, 'empty': {i: 0 for i in ids}}]
    text = r.plan_message(facts, project)
    names = {t.id: t.name for t in tg.fillable(project)}
    want = sorted(((i, n) for i, n in many.items() if n), key=lambda x: -x[1])
    line = ', '.join(f'{names[i]} {n}' for i, n in want[:JOB_PLAN_EMPTY_TARGETS])
    assert f'- "A": 1 sentence, 1 word, 2 characters. Empty: {line}.' in text, text
    assert '- "B": 1 sentence, 1 word, 2 characters. Nothing empty.' in text, text
    monkey = dict(many)
    import plaid_agent.core.limits as limits
    old, limits.JOB_PLAN_EMPTY_TARGETS = limits.JOB_PLAN_EMPTY_TARGETS, 2
    try:
        text = r.plan_message([{**facts[0], 'empty': monkey}], project)
    finally:
        limits.JOB_PLAN_EMPTY_TARGETS = old
    assert f'Empty: {names[want[0][0]]} 9, {names[want[1][0]]} 4, and 1 more.' in text, text
