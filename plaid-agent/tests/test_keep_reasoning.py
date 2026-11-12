"""The bench's reasoning switch (FABLE-REVIEW 2026-11-12, section 3: whether
glm-5.3-flash does better with its reasoning returned between the calls of
one turn). Off by default, the transcript kept between turns never holds
reasoning either way (ruling D1), and only the bench turns it on."""
import json
import sys
from pathlib import Path
from types import SimpleNamespace as NS

sys.path.insert(0, 'tests')

from plaid_agent.core import agent  # noqa: E402
from test_nothing_planned import APPS  # noqa: E402

_ids = iter(range(10 ** 6))


def _reply(*calls, text=None, thought=None):
    tool_calls = [NS(id=f'k{next(_ids)}', function=NS(name=name, arguments=json.dumps(args)))
                  for name, args in calls]
    msg = NS(content=text, tool_calls=tool_calls or None, reasoning_content=thought)
    return NS(choices=[NS(message=msg, finish_reason='stop')], usage=None)


def _turn(monkeypatch, keep):
    ws, kit, plan, read = APPS['igt']()
    script = iter([_reply(read, thought='First I read.'), _reply(plan, thought='Then I plan.'),
                   _reply(text='Planned.', thought='Now I reply.')])
    sent = []

    def complete(cfg, kwargs, on_text, cancelled=None, on_thinking=None, on_busy=None):
        sent.append([dict(m) for m in kwargs['messages']])
        return next(script)

    monkeypatch.setattr(agent, '_complete', complete)
    out = agent.run_turn(agent.ModelConfig(model='stub', keep_reasoning=keep), kit, ws, 'system',
                         [{'role': 'user', 'content': 'x'}])
    return out, sent


def _thoughts(messages):
    return [m.get('reasoning_content') for m in messages if m['role'] == 'assistant']


def test_reasoning_is_not_sent_back_by_default(monkeypatch):
    assert agent.ModelConfig(model='m').keep_reasoning is False
    out, sent = _turn(monkeypatch, False)
    assert len(sent) == 3 and all(_thoughts(m) == [None] * len(_thoughts(m)) for m in sent)
    assert not any('reasoning_content' in m for m in out.messages)


def test_with_the_switch_each_later_call_of_the_turn_gets_the_turns_reasoning(monkeypatch):
    out, sent = _turn(monkeypatch, True)
    assert _thoughts(sent[0]) == []
    assert _thoughts(sent[1]) == ['First I read.']
    assert _thoughts(sent[2]) == ['First I read.', 'Then I plan.']
    # The transcript the turn keeps, which later turns are sent, holds none.
    assert not any('reasoning_content' in m for m in out.messages)


def test_the_service_reads_the_switch_from_its_environment_only():
    from plaid_agent.core import service_cli
    assert agent.KEEP_REASONING_ENV == 'PLAID_AGENT_KEEP_REASONING'
    src = Path(service_cli.__file__).read_text()
    assert 'keep_reasoning=os.environ.get(KEEP_REASONING_ENV) == \'1\'' in src
    assert '--keep-reasoning' not in src


def test_the_bench_sets_it_for_the_arm_that_asks_and_drops_an_exported_one():
    sys.path.insert(0, str(Path(__file__).parent.parent / 'bench'))
    import run
    assert run.KEEP_REASONING_ENV == agent.KEEP_REASONING_ENV
    base = {'PATH': '/bin', run.KEEP_REASONING_ENV: '1'}
    off = run.service_env(Path('/code'), False, base)
    on = run.service_env(Path('/code'), True, {'PATH': '/bin'})
    assert run.KEEP_REASONING_ENV not in off and on[run.KEEP_REASONING_ENV] == '1'
    assert off['PYTHONPATH'] == on['PYTHONPATH'] == '/code/plaid-agent/src:/code/plaid-client-py/src'
