"""A job's model contexts (the owner's rulings 14 and 15 of 2026-11-13): the
planning context, made once and kept; pieces of the three sizes; a piece's
note and the tables its code makes; the final context that writes the
report's prose; and a crash and resume at each new step."""

import json

import pytest

from job_fixtures import JobClient, Model, call, document, keep_plan, reply, runner, start, use

from plaid_agent.core import sandbox
from plaid_agent.core.job import run_job
from plaid_agent.core.prompt import JOB_PLAN_NOW
from plaid_agent.igt import job as igt_job

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
    without), does ``piece(asked, n)`` for a piece, and writes ``summary``."""
    seen = {'plan': 0, 'piece': 0, 'summary': 0}

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
    for m in re.finditer(r'^Empty in s(\d+): words (.*?)(?: and the translation)?\.$', asked, re.M):
        for w, form in re.findall(r'w(\d+) "([^"]*)"', m.group(2)):
            calls.append(call(len(calls) + 1, 'set_analysis', {'document': doc, 'ref': f's{m.group(1)}.w{w}',
                                                              'morphemes': [{'form': form, 'fields': {'Morph Gloss': 'G'}}]}))
    return reply(calls=calls)


# --- the plan ---------------------------------------------------------------------------

def test_the_first_context_plans_and_the_plan_is_kept_and_reported(monkeypatch):
    client = JobClient(_docs())
    job = start(client, 'Segment and gloss the blank words.', id=J, plan=None)
    model = use(monkeypatch, _model(plan={'pieces': 'sentences', 'piece_instructions': 'Gloss ka as go.'},
                                    piece=_gloss_all))
    finished = run_job(job, runner(job, write_summary=True))
    assert finished['state'] == 'done'
    assert model.calls[0]['asked'].splitlines()[0] == 'Instructions from user:'
    assert 'Story 1": 2 sentences, 3 words, 3 words nobody analysed, 0 empty translations' in model.calls[0]['asked']
    plan_tools = {t['function']['name'] for t in model.calls[0]['kwargs']['tools']}
    assert 'plan_work' in plan_tools and 'set_analysis' not in plan_tools
    assert _plan_rows(client) == [{'pieces': 'sentences', 'piece_instructions': 'Gloss ka as go.', 'documents': None,
                                   'by': 'model', 'why': None}]
    pieces = [c['asked'] for c in model.calls if _kind(c['asked']) == 'piece' and c['n'] == 1]
    assert pieces and all('Instructions from user:\nSegment and gloss the blank words.' in p for p in pieces), \
        'the instructions verbatim'
    assert all('How to do every piece, as the job was planned:\nGloss ka as go.' in p for p in pieces), 'and the plan'
    assert finished['report']['plan']['pieces'] == 'sentences' and finished['report']['plan']['fallback'] == []
    assert finished['report']['summary'] == 'The job glossed the words it was asked to.'
    assert finished['report']['summary_failed'] is False


def test_a_planning_that_ends_without_a_plan_gets_one_decide_now_round_then_works_in_sentences(monkeypatch):
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)
    model = use(monkeypatch, _model(plan=None, piece=_gloss_all))
    finished = run_job(job, runner(job))
    planning = [c for c in model.calls if _kind(c['asked']) == 'plan']
    assert len(planning) == 2, 'the planning, then one round told to end with plan_work'
    assert any(m.get('content') == JOB_PLAN_NOW for m in planning[1]['kwargs']['messages'])
    assert {t['function']['name'] for t in planning[1]['kwargs']['tools']} == {'plan_work'}
    assert finished['report']['plan'] == {'pieces': 'sentences', 'piece_instructions': '', 'documents': None,
                                          'by': 'default', 'why': 'no-plan', 'fallback': []}


def test_a_planning_that_runs_out_of_budget_works_in_sentences(monkeypatch):
    client = JobClient(_docs(1))
    job = start(client, id=J, plan=None)

    def answer(asked, n, kwargs):
        if _kind(asked) == 'plan':
            return reply(calls=[call(n, 'read_document', {'document': 'Story 1'})])
        return _gloss_all(asked, n)
    use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job))
    assert finished['state'] == 'done'
    # Told to decide, it is offered plan_work alone, and its reads are refused
    # until its turn ends: no plan, so the job works in stretches.
    assert finished['report']['plan']['by'] == 'default' and finished['report']['plan']['pieces'] == 'sentences'


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


@pytest.mark.skipif(sandbox.available() is not None, reason='the code sandbox is not installed')
def test_a_selections_code_makes_a_table_kept_as_data_in_the_report(monkeypatch):
    client = JobClient(_docs(2))
    job = start(client, 'Report inconsistent glosses across these texts.', id=J, plan='selection')
    code = ('rows = [[d["name"], len(load(d["id"])["sentences"])] for d in documents()]\n'
            'print(table("Sentences per text", ["text", "sentences"], rows))')

    def piece(asked, n):
        if n == 1:
            return reply(calls=[call(1, 'run_code', {'code': code})])
        return reply('Counted the sentences.')
    use(monkeypatch, _model(piece=piece))
    finished = run_job(job, runner(job))
    assert finished['report']['tables'] == [{'title': 'Sentences per text', 'columns': ['text', 'sentences'],
                                             'rows': [['Story 1', 2], ['Story 2', 2]], 'more': 0}]


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
    assert asked.startswith('The job\'s instructions:\nSegment and gloss')
    assert 'Changes proposed for a person to approve: 0.' in asked and 'Glossed every blank word' in asked
    assert model.calls[-1]['kwargs'].get('tools') in (None, []), 'no tools'
    assert finished['report']['summary'] == 'The job glossed the words it was asked to.'


def test_a_summary_that_cannot_be_written_leaves_the_report_without_prose(monkeypatch):
    client = JobClient(_docs(1))
    job = start(client, id=J)
    use(monkeypatch, _model(piece=_gloss_all, summary=RuntimeError('the model fell over')))
    finished = run_job(job, runner(job, write_summary=True))
    assert finished['state'] == 'done'
    assert finished['report']['summary'] is None and finished['report']['summary_failed'] is True


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
