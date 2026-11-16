"""A job piece's model call may write at most a fixed number of tokens, its
reasoning included (``JOB_PIECE_OUTPUT_TOKENS``, the worker's
``--piece-output-tokens``), smaller than the model's own cap (BRIEF SP item
1). The planning context, the report's prose and a chat keep the model's own
cap. A piece call that reaches the ceiling is dropped as a call at the
model's cap is (none of its tool calls run), and the piece is asked again
once in the same context, its staged plan kept, with a line naming the
ceiling. A second call at the ceiling ends the piece as today: the stretch
fails ``output`` and is halved, one sentence skipped ``failed``. The trace's
round of a cut call says so."""

import glob
import json
import os

import pytest

from job_fixtures import JobClient, Model, call, document, planned, reply, runner, start, targets_named, use

from plaid_agent import jobworker
from plaid_agent.core import agent
from plaid_agent.core.agent import ModelConfig, Toolkit, run_turn
from plaid_agent.core.job import run_job
from plaid_agent.core.limits import JOB_PIECE_OUTPUT_TOKENS
from plaid_agent.core.prompt import job_cut_at_ceiling
from plaid_agent.core.trace import PLAN, READ, Tracer
from plaid_agent.igt import job as igt_job

J = 'JPC'
N = 4
MODEL_CAP = 32768


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
    return analysed


def _analyse(s, i=0):
    return [call(100 * s + 10 * i + w, 'set_analysis', {'document': 'Story', 'ref': f's{s}.w{w}', 'morphemes': [
        {'form': 'x', 'fields': {'Morph Gloss': 'g'}}]}) for w in (1, 2)]


def _is_piece(asked):
    return 'Your piece: s' in str(asked)


def _cut_note_sent(kwargs):
    return any(m.get('role') == 'user' and m.get('content') == job_cut_at_ceiling(JOB_PIECE_OUTPUT_TOKENS)
               for m in kwargs['messages'])


def _run(monkeypatch, answer, plan='sentences', trace_dir=None, **kw):
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    client = JobClient({'d1': _doc()})
    job = start(client, id=J, plan=plan)
    client.analysed = _applying(monkeypatch, client)
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job, trace_dir=trace_dir, **kw))
    return client, job, finished, model


def test_the_ceiling_is_one_number_and_the_worker_flag_defaults_to_it():
    args = jobworker.parser().parse_args(['--url', 'u', '--model', 'm'])
    assert args.piece_output_tokens == JOB_PIECE_OUTPUT_TOKENS
    args = jobworker.parser().parse_args(['--url', 'u', '--model', 'm', '--piece-output-tokens', '9000'])
    assert args.piece_output_tokens == 9000
    assert 0 < JOB_PIECE_OUTPUT_TOKENS < MODEL_CAP


def test_the_worker_hands_the_flag_to_its_runners():
    client = JobClient({'d1': _doc()})
    job = start(client, id=J)
    made = jobworker.APPS['igt'](ModelConfig(model='fake/m'), piece_output_tokens=7000)(job)
    assert made.piece_output_tokens == 7000
    assert igt_job.runner_factory(ModelConfig(model='fake/m'))(job).piece_output_tokens == JOB_PIECE_OUTPUT_TOKENS


def test_piece_calls_carry_the_ceiling_and_planning_and_the_report_do_not(monkeypatch):
    def answer(asked, n, kwargs):
        if not _is_piece(asked):
            return reply('The job glossed the story.')
        return reply(calls=[c for s in targets_named(asked) for c in _analyse(s)]) if n == 1 else reply('Done.')
    client, job, finished, model = _run(monkeypatch, planned(answer), plan=None, write_summary=True)
    assert finished is not None
    piece = [c for c in model.calls if _is_piece(c['asked'])]
    planning = [c for c in model.calls if str(c['asked']).rstrip().endswith('Plan the job and end with plan_work.')]
    other = [c for c in model.calls if c not in piece and c not in planning]
    assert piece and planning and other, 'a piece, the planning and the report each made a call'
    assert {c['kwargs']['max_tokens'] for c in piece} == {JOB_PIECE_OUTPUT_TOKENS}
    assert {c['kwargs']['max_tokens'] for c in planning} == {MODEL_CAP}
    assert {c['kwargs']['max_tokens'] for c in other} == {MODEL_CAP}


def test_the_ceiling_is_never_above_the_models_own_cap(monkeypatch):
    def answer(asked, n, kwargs):
        return reply(calls=[c for s in targets_named(asked) for c in _analyse(s)]) if n == 1 else reply('Done.')
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    client = JobClient({'d1': _doc()})
    job = start(client, id=J)
    model = use(monkeypatch, Model(answer))
    r = igt_job.IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000, max_tokens=4000),
                          count=lambda x: len(str(x)), write_summary=False)
    run_job(job, r)
    assert {c['kwargs']['max_tokens'] for c in model.calls} == {4000}


def test_no_ceiling_when_the_flag_is_zero(monkeypatch):
    def answer(asked, n, kwargs):
        return reply(calls=[c for s in targets_named(asked) for c in _analyse(s)]) if n == 1 else reply('Done.')
    client, job, finished, model = _run(monkeypatch, answer, piece_output_tokens=0)
    assert {c['kwargs']['max_tokens'] for c in model.calls} == {MODEL_CAP}


def test_a_chat_turn_keeps_the_models_cap(monkeypatch):
    seen = []

    def script(**kwargs):
        seen.append(kwargs.get('max_tokens'))
        return reply('Hello.')
    monkeypatch.setattr(agent.litellm, 'completion', script)
    tracer = Tracer(kind=lambda n: READ, describe=lambda n, a: 'Looked', progress=lambda n, a: 'Working…')

    class Ws:
        ops = []
    run_turn(ModelConfig(model='fake/m', stream=False), Toolkit(tools_for=lambda ws: [],
                                                                call_tool=lambda ws, n, a: 'ok', tracer=tracer),
             Ws(), 'system', [{'role': 'user', 'content': 'hi'}])
    assert seen == [MODEL_CAP]


def test_a_call_at_the_ceiling_keeps_what_was_staged_and_is_asked_again_once(monkeypatch):
    """s1 is staged on the first call, the second reaches the ceiling (its
    tool call for s2 never runs), and asked again the piece stages s2: both
    are written, nothing is skipped, and the line names the ceiling."""
    def answer(asked, n, kwargs):
        if not _is_piece(asked):
            return reply('Done.')
        first, *rest = targets_named(asked)
        if n == 1:
            return reply(calls=_analyse(first))
        if n == 2 and not _cut_note_sent(kwargs):
            return reply('...', calls=[c for s in rest for c in _analyse(s, 1)], finish='length')
        if n == 2:
            return reply(calls=[c for s in rest for c in _analyse(s, 2)])
        return reply('Done.')
    client, job, finished, model = _run(monkeypatch, answer)
    assert not job.rows['d1'].get('skipped')
    assert job.rows['d1']['done'] == N
    notes = [c for c in model.calls if _cut_note_sent(c['kwargs'])]
    assert notes, 'the piece was asked again with the line naming the ceiling'
    line = job_cut_at_ceiling(JOB_PIECE_OUTPUT_TOKENS)
    assert f'{JOB_PIECE_OUTPUT_TOKENS:,}' in line and 'smaller steps' in line
    # Every word was analysed: the first call's staging survived the cut
    # call, and the call asked again staged the rest.
    assert client.analysed == {f'd1-s{i}w{k}' for i in range(1, N + 1) for k in (1, 2)}


def test_two_calls_at_the_ceiling_end_the_piece_as_today(monkeypatch):
    """A stretch holding s2 reaches the ceiling twice: it is halved, and s2
    alone, reaching it twice again, is skipped failed with the kind output,
    as a call at the model's own cap was before."""
    def answer(asked, n, kwargs):
        if 2 in targets_named(asked):
            if n == 1 and not _cut_note_sent(kwargs):
                return reply(calls=_analyse(targets_named(asked)[0]))
            return reply('...', finish='length')
        return reply(calls=[c for s in targets_named(asked) for c in _analyse(s)]) if n == 1 else reply('Done.')
    client, job, finished, model = _run(monkeypatch, answer)
    assert job.rows['d1']['skipped'] == [{'sentence': 's2', 'sentence_id': 'd1-s2', 'reason': 'failed',
                                          'kind': 'output'}]
    asked_again = [c for c in model.calls if 2 in targets_named(c['asked']) and _cut_note_sent(c['kwargs'])]
    assert len({str(c['asked']) for c in asked_again}) == 2, 'each stretch holding s2 was asked again once'


def test_the_trace_says_a_call_reached_the_ceiling(monkeypatch, tmp_path):
    def answer(asked, n, kwargs):
        if not _cut_note_sent(kwargs):
            return reply('...', finish='length')
        return reply(calls=[c for s in targets_named(asked) for c in _analyse(s)]) if n == 1 else reply('Done.')
    _run(monkeypatch, answer, trace_dir=str(tmp_path))
    rounds = [json.load(open(p)) for p in glob.glob(os.path.join(str(tmp_path), '**', 'round-*.json'),
                                                       recursive=True)]
    cut = [r for r in rounds if r.get('cut_at_tokens')]
    assert cut and {r['cut_at_tokens'] for r in cut} == {JOB_PIECE_OUTPUT_TOKENS}
