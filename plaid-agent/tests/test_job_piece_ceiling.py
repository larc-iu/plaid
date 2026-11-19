"""What a job's piece does when a model call reaches its output limit (BRIEF
SP item 1, after the real-model measurement of 2026-11-16).

By default a piece's calls write up to the model's own cap, as every other
call does: a ceiling below it (``--piece-output-tokens``, 0 by default)
made glossing slower, since long calls were mostly useful work. An operator
may still set one, and only a piece's calls carry it.

Whichever limit a piece's call reaches (the model's own or an operator's
ceiling), the call is dropped (none of its tool calls run), what the piece
staged before it is kept, and the piece is asked again once in the same
context with a line naming that limit. The second call at the limit in the
same piece ends it without finishing: what it staged is written, the rest
handled by the piece's kind (REV-RW-6, test_job_cut_twice.py), or, with
nothing staged, the stretch fails as before (``output``, halved). The trace's
round of a cut call says so. The planning context and the report's prose fail as before."""

import glob
import json
import os

from job_fixtures import JobClient, Model, call, document, planned, reply, runner, start, targets_named, use

from plaid_agent import jobworker
from plaid_agent.core import agent
from plaid_agent.core.agent import ModelConfig, Toolkit, run_turn
from plaid_agent.core.job import run_job
from plaid_agent.core.limits import JOB_PIECE_OUTPUT_TOKENS
from plaid_agent.core.prompt import job_cut_at_limit
from plaid_agent.core.trace import READ, Tracer
from plaid_agent.igt import job as igt_job

J = 'JPC'
N = 4
MODEL_CAP = agent.DEFAULT_MAX_OUTPUT_TOKENS
CEILING = 12000


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


def _cut_note(kwargs):
    """The limit the line a piece was asked again with names, or None."""
    for m in kwargs['messages']:
        for limit in (MODEL_CAP, CEILING):
            if m.get('role') == 'user' and m.get('content') == job_cut_at_limit(limit):
                return limit
    return None


def _run(monkeypatch, answer, plan='sentences', trace_dir=None, **kw):
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    client = JobClient({'d1': _doc()})
    job = start(client, id=J, plan=plan)
    client.analysed = _applying(monkeypatch, client)
    model = use(monkeypatch, Model(answer))
    finished = run_job(job, runner(job, trace_dir=trace_dir, **kw))
    return client, job, finished, model


def _every_word(*sentences):
    return {f'd1-s{i}w{k}' for i in sentences for k in (1, 2)}


# --- the limit a piece's call writes under ------------------------------------------------------------

def test_no_ceiling_by_default_and_the_flag_sets_one():
    assert JOB_PIECE_OUTPUT_TOKENS == 0, 'none: a piece writes up to the model\'s own cap'
    args = jobworker.parser().parse_args(['--url', 'u', '--model', 'm'])
    assert args.piece_output_tokens == 0
    args = jobworker.parser().parse_args(['--url', 'u', '--model', 'm', '--piece-output-tokens', '9000'])
    assert args.piece_output_tokens == 9000


def test_the_worker_hands_the_flag_to_its_runners():
    client = JobClient({'d1': _doc()})
    job = start(client, id=J)
    made = jobworker.APPS['igt'](ModelConfig(model='fake/m'), piece_output_tokens=7000)(job)
    assert made.piece_output_tokens == 7000
    assert not igt_job.runner_factory(ModelConfig(model='fake/m'))(job).piece_output_tokens


def _all(asked, n, kwargs):
    if not _is_piece(asked):
        return reply('The job glossed the story.')
    return reply(calls=[c for s in targets_named(asked) for c in _analyse(s)]) if n == 1 else reply('Done.')


def _limits(model):
    piece = [c for c in model.calls if _is_piece(c['asked'])]
    planning = [c for c in model.calls if str(c['asked']).rstrip().endswith('Plan the job and end with plan_work.')]
    other = [c for c in model.calls if c not in piece and c not in planning]
    assert piece and planning and other, 'a piece, the planning and the report each made a call'
    return ({c['kwargs']['max_tokens'] for c in piece}, {c['kwargs']['max_tokens'] for c in planning},
            {c['kwargs']['max_tokens'] for c in other})


def test_by_default_every_call_of_a_job_writes_up_to_the_models_cap(monkeypatch):
    client, job, finished, model = _run(monkeypatch, planned(_all), plan=None, write_summary=True)
    assert _limits(model) == ({MODEL_CAP}, {MODEL_CAP}, {MODEL_CAP})


def test_a_ceiling_an_operator_sets_goes_on_piece_calls_only(monkeypatch):
    client, job, finished, model = _run(monkeypatch, planned(_all), plan=None, write_summary=True,
                                        piece_output_tokens=CEILING)
    assert _limits(model) == ({CEILING}, {MODEL_CAP}, {MODEL_CAP})


def test_the_ceiling_is_never_above_the_models_own_cap(monkeypatch):
    monkeypatch.setattr(igt_job, 'JOB_STRETCH_SENTENCES', 2)
    client = JobClient({'d1': _doc()})
    job = start(client, id=J)
    model = use(monkeypatch, Model(_all))
    r = igt_job.IgtRunner(job, ModelConfig(model='fake/m', stream=False, max_steps=1000, max_tokens=4000),
                          count=lambda x: len(str(x)), write_summary=False, piece_output_tokens=CEILING)
    run_job(job, r)
    assert {c['kwargs']['max_tokens'] for c in model.calls} == {4000}


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


# --- the first call at the limit: asked again --------------------------------------------------------

def _once_cut(asked, n, kwargs):
    """s(first) staged on the first call, the second reaches the limit (its
    tool call for the rest never runs), and asked again the piece stages
    the rest."""
    if not _is_piece(asked):
        return reply('Done.')
    first, *rest = targets_named(asked)
    if n == 1:
        return reply(calls=_analyse(first))
    if n == 2 and _cut_note(kwargs) is None:
        return reply('...', calls=[c for s in rest for c in _analyse(s, 1)], finish='length')
    if n == 2:
        return reply(calls=[c for s in rest for c in _analyse(s, 2)])
    return reply('Done.')


def test_a_call_at_the_models_own_cap_keeps_what_was_staged_and_is_asked_again_once(monkeypatch):
    """With no ceiling (the default), the recovery holds at the model's own
    cap: before, the whole stretch failed and was halved, what it staged
    lost."""
    client, job, finished, model = _run(monkeypatch, _once_cut)
    assert not job.rows['d1'].get('skipped') and job.rows['d1']['done'] == N
    assert {_cut_note(c['kwargs']) for c in model.calls} - {None} == {MODEL_CAP}
    assert client.analysed == _every_word(*range(1, N + 1))


def test_a_call_at_an_operators_ceiling_is_asked_again_naming_the_ceiling(monkeypatch):
    client, job, finished, model = _run(monkeypatch, _once_cut, piece_output_tokens=CEILING)
    assert not job.rows['d1'].get('skipped') and job.rows['d1']['done'] == N
    assert {_cut_note(c['kwargs']) for c in model.calls} - {None} == {CEILING}
    assert client.analysed == _every_word(*range(1, N + 1))


def test_the_line_names_the_limit_and_says_what_is_true():
    line = job_cut_at_limit(MODEL_CAP)
    assert line.startswith(f'(system) Your last call reached {MODEL_CAP:,} tokens, ') and 'smaller steps' in line
    assert 'none of its tool calls ran' in line and 'What you staged before it is kept' in line


def test_two_calls_at_the_limit_with_nothing_staged_end_the_piece_as_before(monkeypatch):
    def answer(asked, n, kwargs):
        if 2 in targets_named(asked):
            return reply('...', finish='length')
        return reply(calls=[c for s in targets_named(asked) for c in _analyse(s)]) if n == 1 else reply('Done.')
    client, job, finished, model = _run(monkeypatch, answer)
    assert job.rows['d1']['skipped'] == [{'sentence': 's2', 'sentence_id': 'd1-s2', 'reason': 'failed',
                                          'kind': 'output'}]
    asked_again = [c for c in model.calls if 2 in targets_named(c['asked']) and _cut_note(c['kwargs'])]
    assert len({str(c['asked']) for c in asked_again}) == 2, 'each stretch holding s2 was asked again once'
    assert client.analysed == _every_word(1, 3, 4)


def test_the_trace_says_a_call_reached_the_limit(monkeypatch, tmp_path):
    def answer(asked, n, kwargs):
        if _cut_note(kwargs) is None:
            return reply('...', finish='length')
        return reply(calls=[c for s in targets_named(asked) for c in _analyse(s)]) if n == 1 else reply('Done.')
    _run(monkeypatch, answer, trace_dir=str(tmp_path))
    rounds = [json.load(open(p)) for p in glob.glob(os.path.join(str(tmp_path), '**', 'round-*.json'),
                                                       recursive=True)]
    cut = [r for r in rounds if r.get('cut_at_tokens')]
    assert cut and {r['cut_at_tokens'] for r in cut} == {MODEL_CAP}


def _rounds(tmp_path):
    out = {}
    for p in glob.glob(os.path.join(str(tmp_path), '**', 'round-*.json'), recursive=True):
        out.setdefault(os.path.dirname(p), []).append(json.load(open(p)))
    return {k: sorted(v, key=lambda r: r['n']) for k, v in out.items()}


def test_a_piece_whose_first_call_is_cut_keeps_what_it_was_asked_in_its_trace(monkeypatch, tmp_path):
    """REV-SP-1: the round of a first call cut at the limit holds the
    piece's message as received, as round 1 of any piece does, whether the
    piece is then asked again or (cut twice, nothing staged) fails."""
    def answer(asked, n, kwargs):
        if 2 in targets_named(asked) or _cut_note(kwargs) is None:
            return reply('...', finish='length')
        return reply(calls=[c for s in targets_named(asked) for c in _analyse(s)]) if n == 1 else reply('Done.')
    _run(monkeypatch, answer, trace_dir=str(tmp_path))
    pieces = _rounds(tmp_path)
    assert pieces
    for folder, rounds in pieces.items():
        first = rounds[0]
        assert first['n'] == 1 and first.get('cut_at_tokens') == MODEL_CAP, (folder, first)
        assert 'Your piece: s' in (first.get('asked') or ''), (folder, first)


def test_a_negative_ceiling_is_refused_at_startup(capsys):
    """REV-SP-6: -1 was sent as max_tokens and every piece failed."""
    import pytest
    with pytest.raises(SystemExit):
        jobworker.parser().parse_args(['--url', 'u', '--model', 'm', '--piece-output-tokens', '-1'])
    assert '--piece-output-tokens takes 0 (none) or a positive number of tokens, not -1' in capsys.readouterr().err


# --- what a piece's calls count (REV-SP-7, -8) -----------------------------------------------------

def _piece_turn(monkeypatch, script, ceiling=None, ws=None):
    from types import SimpleNamespace
    from plaid_agent.core.job import Pace
    monkeypatch.setattr(agent.litellm, 'completion', script)
    tracer = Tracer(kind=lambda n: READ, describe=lambda n, a: 'Looked', progress=lambda n, a: 'Working…')
    ws = ws or SimpleNamespace(ops=[{'kind': 'x'}])
    pace = Pace('fake/m', count=lambda x: 1, output_tokens=ceiling, asks_again=True)
    return run_turn(ModelConfig(model='fake/m', stream=False), Toolkit(tools_for=lambda w: [],
                                                                       call_tool=lambda w, n, a: 'ok', tracer=tracer),
                    ws, 'system', [{'role': 'user', 'content': 'Your piece: s1.'}], pace=pace)


def test_a_cut_call_the_provider_reports_nothing_for_counts_the_limit_it_reached(monkeypatch):
    """REV-SP-8: the ask-again path added the cut call's usage only when the
    provider reported it. Now one it reports nothing for counts the prompt
    by the tokenizer and the limit it reached as written."""
    from types import SimpleNamespace
    monkeypatch.setattr(agent, '_sent_tokens', lambda model, kwargs, max_tokens=None: 100 + (max_tokens or 0))
    answers = iter([reply('...', finish='length'),
                    SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='Done.', tool_calls=None),
                                                             finish_reason='stop')],
                                    usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5))])
    result = _piece_turn(monkeypatch, lambda **kw: next(answers))
    assert result.usage['total'] == {'sent': 110, 'received': MODEL_CAP + 5, 'calls': 2}


def test_a_refusal_as_too_long_is_measured_with_the_limit_the_call_was_sent_with(monkeypatch):
    """REV-SP-7: a piece's call under a ceiling was measured with the
    model's own cap when the provider refused it as too long."""
    import litellm
    from types import SimpleNamespace
    seen = []
    monkeypatch.setattr(agent, '_sent_tokens', lambda model, kwargs, max_tokens=None: max_tokens)
    monkeypatch.setattr(agent, 'learn_window', lambda model, e, sent=None, stated=None: seen.append(sent))
    calls = {'n': 0}

    def script(**kw):
        calls['n'] += 1
        if calls['n'] == 1:
            raise litellm.ContextWindowExceededError('too long', model='fake/m', llm_provider='openai')
        return reply('Done.')
    ws = SimpleNamespace(ops=[{'kind': 'x'}], shrink=lambda history, new: list(history))
    _piece_turn(monkeypatch, script, ceiling=CEILING, ws=ws)
    assert seen == [CEILING]
