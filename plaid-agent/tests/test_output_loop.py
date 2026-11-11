"""A model call that falls into a loop, and a turn whose last call fails
after a plan was staged.

PROD-LOOP (2026-11-10): glm-5.3-flash wrote "Make the calls first. Then
reply." 1,635 times into its visible reply until the 32,768-token output cap.
A plan was staged, so the turn was stored as "(The model did not answer.)"
with the plan card: the cap went unsaid, the looping text was in no place the
panel shows, and the failed call's tokens were left out of the turn's usage.
"""

from types import SimpleNamespace

import pytest

from test_kept_plan_failure import LOOP, _call, _kit, _resp, _usage, _Ws

from plaid_agent.core import agent
from plaid_agent.core.agent import REPEAT_MIN_TIMES, REPEATING_LINE, ModelConfig, TurnFailed, repeating, run_turn


# --- the rule ---------------------------------------------------------------------

@pytest.mark.parametrize('sep', ['\n', '\n\n', ' ', ''])
def test_the_recorded_loop_is_repeating(sep):
    text = 'Staged 47 changes. Hmm, s18.w2 is wrong.\n' + sep.join([LOOP] * REPEAT_MIN_TIMES)
    assert repeating(text) is not None


def test_the_loop_is_found_with_its_last_copy_half_written():
    text = 'Draft.\n' + '\n'.join([LOOP] * (REPEAT_MIN_TIMES + 1)) + '\nMake the ca'
    assert repeating(text) is not None


def test_whitespace_between_copies_may_vary():
    seps = ['\n', '\n\n', ' ', '\n \n']
    text = ''.join(LOOP + seps[i % len(seps)] for i in range(REPEAT_MIN_TIMES + 1))
    assert repeating(text) is not None


def test_fewer_copies_than_the_rule_is_not_repeating():
    assert repeating('\n'.join([LOOP] * (REPEAT_MIN_TIMES - 2))) is None


def test_a_unit_longer_than_the_rule_is_not_looked_for():
    unit = 'x' * 150 + ' ' + 'y' * 100 + '.'
    assert repeating(' '.join([unit] * (REPEAT_MIN_TIMES + 2))) is None


TABLE = '| Sentence | Word | Gloss |\n|---|---|---|\n' + ''.join(
    f'| s{i} | w{i % 7 + 1} | 3SG-NOM |\n' for i in range(1, 80))
GLOSSES = '\n'.join(f'{i}. dog-PL.NOM' for i in range(1, 80))
SAME_GLOSSES = '- NOM\n' * 80
PUNCTUATION = 'Done' + '.' * 3000 + '\n' + '-' * 3000 + '\n' + '=' * 500
BLANK_LINES = '```\ndef f():\n' + '\n' * 400 + '    pass\n' + '    \n' * 300 + '```'
IGT = ('\\t ka-ka-ka-ka-ka-ka-ka-ka-ka-ka-ka-ka-ka-ka-ka-ka-ka-ka-ka-ka-ka-ka-ka-ka-ka\n'
       '\\g ' + 'NOM ' * 60 + '\n' + '\\m ' + 'ta=ta=' * 50 + '\n'
       + 'house-PL ' * 40 + '\n' + '3SG.POSS-house ' * 19)
DIGITS = '0' * 3000 + ' ' + '1, ' * 400 + '\n' + '1234' * 500 + ' ' + '3.14159 ' * 300
EMPTY_ROWS = '| | | | |\n' * 100 + '| — | — | — |\n' * 100 + '| ? | ? | ? | ? |\n' * 100


@pytest.mark.parametrize('text', [TABLE, GLOSSES, SAME_GLOSSES, PUNCTUATION, BLANK_LINES, IGT, DIGITS, EMPTY_ROWS],
                         ids=['table', 'glosses', 'same gloss', 'punctuation', 'blank lines', 'igt', 'digits',
                              'empty rows'])
def test_legitimate_repetition_is_not_repeating(text):
    # Every prefix as it streams, not only the whole: the guard looks at the
    # text after every chunk.
    for end in range(50, len(text) + 1, 37):
        assert repeating(text[:end]) is None, repr(text[max(0, end - 200):end])
    assert repeating(text) is None


def test_a_short_unit_before_a_long_loop_does_not_hide_it():
    unit = 'Then reply now.......................'
    assert repeating(' '.join([unit] * (REPEAT_MIN_TIMES + 1))) is not None


# --- the streaming loop ---------------------------------------------------------------

class _Stream:
    """A provider stream that would go on for ever, and says when it is closed."""

    def __init__(self, pieces, field='content'):
        self.pieces = pieces
        self.field = field
        self.closed = False
        self.read = 0

    def __iter__(self):
        for p in self.pieces():
            if self.closed:
                raise AssertionError('read after close')
            self.read += 1
            delta = SimpleNamespace(content=None, reasoning_content=None)
            setattr(delta, self.field, p)
            yield SimpleNamespace(choices=[SimpleNamespace(delta=delta)])

    def close(self):
        self.closed = True


def _forever(head, unit):
    def pieces():
        yield head
        n = 0
        while True:
            n += 1
            if n > 100_000:
                raise AssertionError('the stream was never stopped')
            yield unit
    return pieces


@pytest.mark.parametrize('field', ['content', 'reasoning_content'])
def test_a_looping_call_is_stopped_closed_and_not_tried_again(monkeypatch, field):
    monkeypatch.setattr(agent, 'STREAM_INTERVAL_S', 0)
    streams = []

    def completion(**kwargs):
        streams.append(_Stream(_forever('Staged 47 changes.\n', LOOP + '\n'), field))
        return streams[-1]

    monkeypatch.setattr(agent.litellm, 'completion', completion)
    texts, thoughts = [], []
    with pytest.raises(TurnFailed) as e:
        agent._complete(ModelConfig(model='m'), {'model': 'm', 'messages': []}, texts.append,
                        on_thinking=thoughts.append)
    assert str(e.value) == REPEATING_LINE
    [stream] = streams
    assert stream.closed, 'the provider is told to stop writing'
    assert stream.read <= REPEAT_MIN_TIMES + 3, 'stopped as soon as the rule is met'
    seen = texts if field == 'content' else thoughts
    assert seen[-1].startswith('Staged 47 changes.') and seen[-1].count(LOOP) >= REPEAT_MIN_TIMES, \
        'the text so far is handed on whole before the call ends'


def test_a_litellm_stream_is_closed_through_the_response_under_it():
    """litellm's stream wrapper has no close of its own: the provider's
    stream under it (the openai SDK's, which closes the HTTP response) is
    closed."""
    inner = SimpleNamespace(closed=False)
    inner.close = lambda: setattr(inner, 'closed', True)
    agent.close_stream(SimpleNamespace(completion_stream=inner))
    assert inner.closed


# --- a turn whose last call fails after a plan ---------------------------------------

def test_a_looping_call_after_a_plan_says_so_and_counts_what_it_wrote(monkeypatch, capsys):
    monkeypatch.setattr(agent, 'STREAM_INTERVAL_S', 0)
    calls = []

    def completion(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            return _resp(calls=[_call(1, 'plan_a', '{}')], usage=_usage(1000, 50))
        return _Stream(_forever('Staged.\n', LOOP + '\n'))

    monkeypatch.setattr(agent.litellm, 'completion', completion)
    ws = _Ws()
    turn = run_turn(ModelConfig(model='fake/m'), _kit(), ws, 'system', [{'role': 'user', 'content': 'go'}])
    assert len(calls) == 2, 'not tried again'
    assert len(ws.ops) == 1
    assert turn.text == f'({REPEATING_LINE})'
    assert turn.partial.startswith('Staged.') and LOOP in turn.partial
    total = turn.usage['total']
    assert total['calls'] == 2 and total['received'] > 50, 'what it wrote is counted'
    assert turn.usage['received'] == 50, 'a count of ours is not the provider\'s figure for the gauge'
    assert 'repeating' in capsys.readouterr().out


def test_a_looping_call_with_nothing_planned_fails_the_turn_with_its_text(monkeypatch):
    monkeypatch.setattr(agent, 'STREAM_INTERVAL_S', 0)
    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: _Stream(_forever('Hmm.\n', LOOP + ' ')))
    with pytest.raises(TurnFailed) as e:
        run_turn(ModelConfig(model='fake/m'), _kit(), _Ws(), 'system', [{'role': 'user', 'content': 'go'}])
    assert str(e.value) == REPEATING_LINE
    _steps, partial = agent.turn_trace(e.value)
    assert partial.startswith('Hmm.') and LOOP in partial
