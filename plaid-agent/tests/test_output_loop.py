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
    assert stream.read <= REPEAT_MIN_TIMES + 3 + agent.REPEAT_CHECK_CHARS // len(LOOP), \
        'stopped once the rule is met, within REPEAT_CHECK_CHARS'
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


# --- every way out of a stream closes it, and litellm's own guard (REV-PB-C-2) -------

class _Failing(_Stream):
    """A stream that yields ``pieces`` and then raises ``error``, or ends
    there when there is none, and counts its closes."""

    def __init__(self, pieces, error=None):
        super().__init__(lambda: iter(pieces))
        self.error = error
        self.closes = 0

    def __iter__(self):
        yield from super().__iter__()
        if self.error is not None:
            raise self.error

    def close(self):
        self.closes += 1
        self.closed = True


def _litellm_repeat_error():
    """What litellm 1.102 raises after REPEATED_STREAMING_CHUNK_LIMIT identical
    chunks: its InternalServerError, wrapped by the stream in a
    MidStreamFallbackError (a ServiceUnavailableError, so a transient one)."""
    litellm = agent.litellm
    inner = litellm.InternalServerError(message='The model is repeating the same chunk = ────.',
                                        model='', llm_provider='')
    return litellm.exceptions.MidStreamFallbackError(message=str(inner), model='m', llm_provider='openai',
                                          original_exception=inner, generated_content='────' * 100)


def test_litellms_repeat_error_is_what_litellm_raises():
    from litellm.litellm_core_utils.streaming_handler import CustomStreamWrapper
    wrapper = CustomStreamWrapper.__new__(CustomStreamWrapper)
    delta = SimpleNamespace(content='────')
    wrapper.chunks = [SimpleNamespace(choices=[SimpleNamespace(delta=delta)])] * 2
    wrapper._repeated_messages_count = agent.litellm.REPEATED_STREAMING_CHUNK_LIMIT
    with pytest.raises(agent.litellm.InternalServerError) as e:
        wrapper.raise_on_model_repetition()
    assert agent.litellm_repeating(e.value)
    assert agent.litellm_repeating(_litellm_repeat_error())


def test_other_provider_failures_are_not_litellms_repeat_error():
    litellm = agent.litellm
    down = litellm.ServiceUnavailableError(message='upstream down', model='m', llm_provider='openai')
    assert not agent.litellm_repeating(down)
    assert not agent.litellm_repeating(litellm.exceptions.MidStreamFallbackError(
        message='connection reset', model='m', llm_provider='openai', original_exception=down))
    assert not agent.litellm_repeating(litellm.InternalServerError(
        message='The model is repeating the request', model='m', llm_provider='openai'))
    assert not agent.litellm_repeating(RuntimeError('The model is repeating the same chunk = x'))


@pytest.mark.parametrize('field', ['content', 'reasoning_content'])
def test_a_stream_that_fails_partway_is_closed(monkeypatch, field):
    monkeypatch.setattr(agent, 'STREAM_INTERVAL_S', 0)
    stream = _Failing(['Staged ', 'two.'], RuntimeError('the reader failed'))
    stream.field = field
    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: stream)
    with pytest.raises(RuntimeError):
        agent._complete_once(ModelConfig(model='m'), {'model': 'm', 'messages': []}, lambda t: None)
    assert stream.closed


def test_a_reader_that_fails_closes_the_stream(monkeypatch):
    monkeypatch.setattr(agent, 'STREAM_INTERVAL_S', 0)
    stream = _Stream(_forever('Staged ', 'more words '))
    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: stream)

    def on_text(t):
        if len(t) > 100:
            raise RuntimeError('a reader failed')
    with pytest.raises(RuntimeError):
        agent._complete_once(ModelConfig(model='m'), {'model': 'm', 'messages': []}, on_text)
    assert stream.closed


def test_a_stream_read_to_its_end_is_closed_and_a_second_close_is_harmless(monkeypatch):
    monkeypatch.setattr(agent, 'STREAM_INTERVAL_S', 0)
    stream = _Failing(['All ', 'done.'])
    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: stream)
    resp = agent._complete_once(ModelConfig(model='m'), {'model': 'm', 'messages': []}, lambda t: None)
    assert resp.choices[0].message.content == 'All done.'
    assert stream.closes == 1
    agent.close_stream(stream)
    assert stream.closes == 2


def test_litellms_repeat_error_ends_the_call_as_our_guard_does_and_is_not_tried_again(monkeypatch, capsys):
    monkeypatch.setattr(agent, 'STREAM_INTERVAL_S', 0)
    streams = []

    def completion(**kwargs):
        streams.append(_Failing(['Here is the tree:\n'] + ['────'] * 100, _litellm_repeat_error()))
        return streams[-1]

    monkeypatch.setattr(agent.litellm, 'completion', completion)
    texts = []
    with pytest.raises(TurnFailed) as e:
        agent._complete(ModelConfig(model='m'), {'model': 'm', 'messages': []}, texts.append)
    assert str(e.value) == REPEATING_LINE
    assert len(streams) == 1, 'not tried again'
    assert streams[0].closed
    assert texts[-1].startswith('Here is the tree:') and texts[-1].endswith('────'), 'the text so far is handed on'
    assert 'repeating' in capsys.readouterr().out


def test_litellms_repeat_error_after_a_plan_keeps_the_plan(monkeypatch):
    monkeypatch.setattr(agent, 'STREAM_INTERVAL_S', 0)
    calls = []

    def completion(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            return _resp(calls=[_call(1, 'plan_a', '{}')], usage=_usage(1000, 50))
        return _Failing(['Staged.\n'] + ['ka-ka'] * 100, _litellm_repeat_error())

    monkeypatch.setattr(agent.litellm, 'completion', completion)
    ws = _Ws()
    turn = run_turn(ModelConfig(model='fake/m'), _kit(), ws, 'system', [{'role': 'user', 'content': 'go'}])
    assert len(calls) == 2, 'not tried again'
    assert len(ws.ops) == 1, 'the plan is kept'
    assert turn.text == f'({REPEATING_LINE})'
    assert turn.partial.startswith('Staged.') and 'ka-ka' in turn.partial


def test_another_failure_partway_is_still_tried_again(monkeypatch):
    monkeypatch.setattr(agent, 'STREAM_INTERVAL_S', 0)
    litellm = agent.litellm
    down = litellm.ServiceUnavailableError(message='upstream down', model='m', llm_provider='openai')
    streams = []

    def completion(**kwargs):
        if not streams:
            streams.append(_Failing(['Half '], litellm.exceptions.MidStreamFallbackError(
                message='reset', model='m', llm_provider='openai', original_exception=down)))
        else:
            streams.append(_Failing(['Whole.']))
        return streams[-1]

    monkeypatch.setattr(agent.litellm, 'completion', completion)
    monkeypatch.setattr('plaid_client.workflows.llm.random.uniform', lambda a, b: 0)
    resp = agent._complete(ModelConfig(model='m'), {'model': 'm', 'messages': []}, lambda t: None)
    assert resp.choices[0].message.content == 'Whole.'
    assert len(streams) == 2 and streams[0].closed


def test_litellms_repeat_guard_through_a_real_stream(tmp_path):
    """Through the real litellm against a local server sending one
    4-character chunk over and over (the reviewer's case G): one request, the
    turn's line, and the server sees the client go at once."""
    import http.server
    import json
    import threading
    import time
    state = {'requests': 0, 'sent': 0, 'gone_at': None}
    done = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers.get('Content-Length') or 0))
            state['requests'] += 1
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            try:
                for _ in range(1500):
                    body = {'id': 'c', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'x',
                            'choices': [{'index': 0, 'delta': {'content': '────'}, 'finish_reason': None}]}
                    self.wfile.write(f'data: {json.dumps(body)}\n\n'.encode())
                    self.wfile.flush()
                    state['sent'] += 1
                    time.sleep(0.005)
                self.wfile.write(b'data: [DONE]\n\n')
            except (BrokenPipeError, ConnectionResetError):
                state['gone_at'] = state['sent']
            finally:
                done.set()

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_address[1]}/v1'
    try:
        cfg = ModelConfig(model='openai/x', api_base=base, api_key='k')
        kwargs = {'model': 'openai/x', 'api_base': base, 'api_key': 'k', 'max_retries': 0,
                  'messages': [{'role': 'user', 'content': 'hi'}]}
        with pytest.raises(TurnFailed) as e:
            agent._complete(cfg, kwargs, lambda t: None)
        assert str(e.value) == REPEATING_LINE
        assert done.wait(3), 'the provider was still writing 3 seconds after the guard'
        assert state['requests'] == 1 and state['gone_at'] is not None and state['gone_at'] < 300
    finally:
        server.shutdown()


def test_the_guard_reads_the_text_again_only_once_it_has_grown(monkeypatch):
    """The rule cost 0.2 to 0.3 ms of CPU a chunk whatever its size, 4 to 7 s
    over a reply of 100,000 characters in chunks of 4 (REV-PB-C, S5). It is
    read again once the text or the reasoning has grown by
    REPEAT_CHECK_CHARS, so a loop runs at most that much further."""
    monkeypatch.setattr(agent, 'STREAM_INTERVAL_S', 0)
    seen = []
    real = agent.repeating
    monkeypatch.setattr(agent, 'repeating', lambda t: seen.append(len(t)) or real(t))
    pieces = ['word'] * 25_000
    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: _Stream(lambda: iter(pieces)))
    agent._complete_once(ModelConfig(model='m'), {'model': 'm', 'messages': []}, lambda t: None)
    assert len(seen) <= 100_000 // agent.REPEAT_CHECK_CHARS + 1
    assert all(b - a >= agent.REPEAT_CHECK_CHARS for a, b in zip(seen, seen[1:]))
