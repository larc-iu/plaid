"""BRIEF RW B3: near the end of a piece's budget its reading tools are
withdrawn (the decide-now call, JOB_STRETCH_DECIDE_AT_ROUNDS or
JOB_CALL_DECIDE_AT_TOKENS). The model is told so in the call where it
happens, and a reading tool it calls after it is refused with the next
step, not with "that tool is not one of this job's", which it read as an
error to work around (14 of the 18 pieces of the measured run spent their
last calls so). The line is in the round file of the call it went with."""

import glob
import json
import os

from fixtures import FakeClient, fake_ws
from job_fixtures import JobClient, Model, blank, call, document, reply, runner, start, targets_named, use

from plaid_agent.core.prompt import JOB_DECIDE_NOW, JOB_PLAN_NOW, JOB_PLAN_READING_OVER, JOB_READING_OVER
from plaid_agent.igt import toolkit
from plaid_agent.igt.job import JobWorkspace

J = 'JRO'


def _told(kwargs, line=JOB_DECIDE_NOW):
    return any(m.get('content') == line for m in kwargs['messages'])


def _results(kwargs):
    return [str(m.get('content')) for m in kwargs['messages'] if m.get('role') == 'tool']


def test_the_decide_now_line_says_reading_is_over():
    assert JOB_DECIDE_NOW == ('(system) Decide now with what you have: reading is over for this piece, and only '
                              'the tools that stage changes are left. Stage your work and end with your note.')
    assert JOB_READING_OVER == 'Reading is over for this piece: stage what you have and end.'


def test_a_reading_tool_after_the_decide_now_line_is_refused_with_the_next_step(monkeypatch):
    client = JobClient({'d1': document('d1', 'Story', blank(1))})
    job = start(client, id=J, plan='document')
    seen = {}

    def answer(asked, n, kwargs):
        if _told(kwargs) and 'after' not in seen:
            seen['after'] = True
            # In the very call that carries the line, as the measured model did.
            return reply(calls=[call(200, 'read_document', {'document': 'Story'}),
                                call(201, 'made_up_tool', {})])
        if 'after' in seen:
            seen['results'] = _results(kwargs)[-2:]
            return reply('Done.')
        return reply(calls=[call(100 + n, 'read_document', {'document': 'Story'})])
    use(monkeypatch, Model(answer))
    runner(job).document('d1')
    read, made_up = seen['results']
    assert read.startswith(f'Error: {JOB_READING_OVER}'), read
    assert "not one of this job's" in made_up, 'a tool the piece was never offered is refused as before'


def test_the_refusal_names_only_tools_the_piece_was_offered():
    """A tool offered before the line reads as withdrawn, any other as not
    the job's."""
    ws = JobWorkspace(FakeClient(), fake_ws(FakeClient()).project)
    ws.decide_now = True
    assert str(toolkit.job_piece_call(ws, 'read_document', {'document': 'Story'})).startswith(
        f'Error: {JOB_READING_OVER}')
    assert "not one of this job's" in str(toolkit.job_piece_call(ws, 'propose_job', {'action': 'help'}))
    ws.decide_now = False
    assert "not one of this job's" in str(toolkit.job_piece_call(ws, 'propose_job', {'action': 'help'}))


def test_the_planning_is_told_its_reading_is_over_the_same_way():
    ws = JobWorkspace(FakeClient(), fake_ws(FakeClient()).project, mode=JobWorkspace.PLAN)
    ws.decide_now = True
    assert str(toolkit.job_plan_call(ws, 'read_document', {'document': 'Story'})).startswith(
        f'Error: {JOB_PLAN_READING_OVER}')
    assert JOB_PLAN_READING_OVER == 'Reading is over for the planning: call plan_work now.'
    assert JOB_PLAN_NOW == '(system) End the planning now: call plan_work.'


def test_the_round_that_carried_the_line_keeps_it_in_the_trace(monkeypatch, tmp_path):
    client = JobClient({'d1': document('d1', 'Story', blank(1))})
    job = start(client, id=J, plan='sentences')

    def answer(asked, n, kwargs):
        if _told(kwargs):
            return reply(calls=[call(300, 'set_analysis', {'document': 'Story', 'ref': 's1.w1', 'morphemes': [
                {'form': 'ka', 'type': 'stem', 'fields': {'Morph Gloss': 'go'}}]})]) \
                if not any('Staged' in r for r in _results(kwargs)) else reply('Done.')
        return reply(calls=[call(100 + n, 'read_lexicon', {'pattern': f'x{n}'})])
    use(monkeypatch, Model(answer))
    runner(job, trace_dir=str(tmp_path)).document('d1')
    rounds = sorted((json.load(open(p)) for p in glob.glob(os.path.join(str(tmp_path), '**', 'round-*.json'),
                                                           recursive=True)), key=lambda r: r['n'])
    told = [r['n'] for r in rounds if r.get('asked') == JOB_DECIDE_NOW]
    assert told == [15], [(r['n'], r.get('asked')) for r in rounds]
    assert 'Your piece: s1.' in rounds[0]['asked']
    assert not any(r.get('asked') for r in rounds if r['n'] not in (1, 15))
