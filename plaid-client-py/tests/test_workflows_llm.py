"""Tests for the chat model both LLM services now share.

litellm is never imported here: the module imports it inside the call, and a
fake stands in for it. Run::

    cd plaid-client-py && python -m pytest tests/ -q
"""

import argparse
import os
import sys
import threading
import time
import types

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.services import ServiceCancelled  # noqa: E402
from plaid_client.workflows import llm  # noqa: E402


class _RateLimited(Exception):
    pass


class _Timeout(Exception):
    pass


class _Usage:
    def __init__(self, prompt=11, completion=7):
        self.prompt_tokens = prompt
        self.completion_tokens = completion


def _response(text, finish_reason='stop', cost=0.002):
    message = types.SimpleNamespace(content=text)
    choice = types.SimpleNamespace(message=message, finish_reason=finish_reason)
    return types.SimpleNamespace(choices=[choice], usage=_Usage(),
                                 _hidden_params={'response_cost': cost})


def _fake_litellm(responses):
    """A litellm whose completion() walks `responses`, raising any exception it
    finds there."""
    calls = []

    def completion(**kwargs):
        calls.append(kwargs)
        item = responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    fake = types.SimpleNamespace(completion=completion, calls=calls,
                                 RateLimitError=_RateLimited, Timeout=_Timeout)
    return fake


@pytest.fixture
def no_sleep(monkeypatch):
    slept = []
    monkeypatch.setattr(llm.time, 'sleep', lambda s: slept.append(s))
    return slept


def _install(monkeypatch, fake):
    monkeypatch.setitem(sys.modules, 'litellm', fake)


def test_a_reply_carries_its_text_and_its_usage(monkeypatch):
    fake = _fake_litellm([_response('  house(ev)-PL(ler)  ')])
    _install(monkeypatch, fake)
    model = llm.ChatModel('openai/x', api_base='http://gpu:8000/v1', max_tokens=64)
    reply = model.complete('sys', 'user')
    assert reply.text == 'house(ev)-PL(ler)' and reply.truncated is False
    assert reply.usage == {'prompt_tokens': 11, 'completion_tokens': 7}
    assert fake.calls[0]['api_base'] == 'http://gpu:8000/v1'
    assert fake.calls[0]['max_tokens'] == 64
    assert fake.calls[0]['timeout'] == llm.DEFAULT_TIMEOUT_S
    # The provider SDK does not retry on its own under ours.
    assert fake.calls[0]['max_retries'] == 0


def test_the_endpoint_stays_out_of_what_a_row_records():
    # provDetail is readable by every reader of the project.
    model = llm.ChatModel('openai/x', api_base='http://gpu:8000/v1')
    assert model.describe() == {'model': 'openai/x'}


def test_a_reply_that_ran_out_of_room_says_so(monkeypatch):
    _install(monkeypatch, _fake_litellm([_response('half a transl', finish_reason='length')]))
    reply = llm.ChatModel('openai/x').complete('sys', 'user')
    assert reply.truncated is True and reply.text == 'half a transl'


def test_a_rate_limit_is_waited_out_rather_than_failing_the_sentence(monkeypatch, no_sleep):
    # A whole document is one call per sentence, so a burst of 429s used to
    # fail every sentence the run touched and write nothing at all.
    fake = _fake_litellm([_RateLimited('slow down'), _RateLimited('slow down'),
                          _response('done')])
    _install(monkeypatch, fake)
    reply = llm.ChatModel('openai/x').complete('sys', 'user')
    assert reply.text == 'done'
    assert len(fake.calls) == 3 and len(no_sleep) == 2
    assert all(0 <= s <= llm.RETRY_BASE_S * 4 for s in no_sleep)


def test_a_provider_still_refusing_after_the_last_try_raises(monkeypatch, no_sleep):
    fake = _fake_litellm([_RateLimited('slow down')] * 4)
    _install(monkeypatch, fake)
    with pytest.raises(_RateLimited):
        llm.ChatModel('openai/x', retries=3).complete('sys', 'user')
    assert len(fake.calls) == 4


def test_what_a_run_spent_is_on_the_operators_log(monkeypatch):
    _install(monkeypatch, _fake_litellm([_response('a'), _response('b')]))
    model = llm.ChatModel('openai/x')
    model.complete('sys', 'one')
    model.complete('sys', 'two')
    line = model.usage_line()
    assert '2 call(s)' in line and '22 prompt + 14 completion tokens' in line
    assert '0.0040' in line


def test_provider_keys_are_collected_from_the_flag_and_the_environment():
    env = {'OPENAI_API_KEY': 'sk-env', 'PATH': '/usr/bin', 'SOMETHING_API_KEY': ''}
    assert llm.provider_secrets('sk-flag', environ=env) == ('sk-flag', 'sk-env')
    assert llm.provider_secrets(None, environ={'PATH': '/usr/bin'}) == ()


def test_a_timeout_is_tried_once_more_and_then_named_for_the_requester(monkeypatch, no_sleep):
    # A model that never answers used to be retried three times at the
    # provider's 600 s: forty minutes per sentence under the write lock.
    fake = _fake_litellm([_Timeout('Request timed out at http://gpu:8000/v1')] * 5)
    _install(monkeypatch, fake)
    with pytest.raises(llm.ModelTimeout) as caught:
        llm.ChatModel('openai/x', timeout=30).complete('sys', 'user')
    assert len(fake.calls) == 2
    assert all(call['timeout'] == 30 for call in fake.calls)
    assert str(caught.value) == 'The model did not answer within 30 seconds.'


def test_a_timeout_then_an_answer_is_an_answer(monkeypatch, no_sleep):
    _install(monkeypatch, _fake_litellm([_Timeout('slow'), _response('ok')]))
    assert llm.ChatModel('openai/x').complete('sys', 'user').text == 'ok'


def test_a_stop_ends_a_call_the_provider_never_answers(monkeypatch):
    # The endpoint accepts the request and goes silent. Stop must still end
    # the call, not wait out the deadline.
    monkeypatch.setattr(llm, 'STOP_POLL_S', 0.01)
    release = threading.Event()
    started = threading.Event()

    def completion(**kwargs):
        started.set()
        release.wait(10)
        return _response('too late')

    _install(monkeypatch, types.SimpleNamespace(completion=completion))
    stop = {'asked': False}

    def ask_later():
        started.wait(5)
        time.sleep(0.05)
        stop['asked'] = True

    threading.Thread(target=ask_later, daemon=True).start()
    began = time.monotonic()
    try:
        with pytest.raises(ServiceCancelled):
            llm.ChatModel('openai/x').complete('sys', 'user', should_stop=lambda: stop['asked'])
        assert time.monotonic() - began < 2
    finally:
        release.set()


def test_a_stop_is_honoured_before_a_retry(monkeypatch, no_sleep):
    fake = _fake_litellm([_RateLimited('slow down'), _response('never asked for')])
    _install(monkeypatch, fake)
    asked = []

    def should_stop():
        asked.append(True)
        return len(fake.calls) >= 1

    with pytest.raises(ServiceCancelled):
        llm.ChatModel('openai/x').complete('sys', 'user', should_stop=should_stop)
    assert len(fake.calls) == 1


def test_a_stop_before_the_call_asks_nothing(monkeypatch):
    fake = _fake_litellm([_response('never asked for')])
    _install(monkeypatch, fake)
    with pytest.raises(ServiceCancelled):
        llm.ChatModel('openai/x').complete('sys', 'user', should_stop=lambda: True)
    assert fake.calls == []


def test_a_provider_error_reaches_the_caller_through_the_worker_thread(monkeypatch):
    monkeypatch.setattr(llm, 'STOP_POLL_S', 0.01)
    # Refused as a stream, then refused again unstreamed: the second refusal is
    # the one that reaches the caller.
    fake = _fake_litellm([ValueError('bad request'), ValueError('bad request')])
    _install(monkeypatch, fake)
    with pytest.raises(ValueError, match='bad request'):
        llm.ChatModel('openai/x').complete('sys', 'user', should_stop=lambda: False)
    assert [c.get('stream') for c in fake.calls] == [True, None]


def test_the_timeout_flag_reaches_the_model():
    parser = argparse.ArgumentParser()
    llm.add_model_arguments(parser)
    assert parser.parse_args(['--model', 'm']).timeout == llm.DEFAULT_TIMEOUT_S
    args = parser.parse_args(['--model', 'm', '--timeout', '45'])

    class _Service:
        service_name = 'LLM glossing'
        service_id = 'llm-analyzer'

    assert llm.setup_service(_Service(), args).timeout == 45


def test_setup_service_takes_the_operators_identity_overrides():
    class _Service:
        service_name = 'LLM glossing'
        service_id = 'llm-analyzer'
        REQUEST_SECRETS = ()

    args = types.SimpleNamespace(model='ollama/llama3.1', api_base=None, api_key='sk-flag',
                                 temperature=0.0, max_tokens=None, timeout=60,
                                 service_id='llm-analyzer-llama', service_name=None)
    svc = _Service()
    model = llm.setup_service(svc, args)
    assert svc.model is model and model.model == 'ollama/llama3.1'
    assert svc.service_id == 'llm-analyzer-llama'
    assert svc.service_name == 'LLM glossing (ollama/llama3.1)'
    assert 'sk-flag' in svc.REQUEST_SECRETS


# --- a run that stops asking a model that does not answer ---------------------

class _Unreachable(Exception):
    pass


def test_a_run_stops_after_two_sentences_in_a_row_get_no_answer(monkeypatch):
    from plaid_client.workflows.llm import ModelTimeout, UnansweredRun, did_not_answer
    monkeypatch.setitem(sys.modules, 'litellm', types.SimpleNamespace(
        APIConnectionError=_Unreachable, ServiceUnavailableError=_Unreachable))
    down = _Unreachable('refused')
    assert did_not_answer(ModelTimeout('x')) and did_not_answer(down)
    assert not did_not_answer(RuntimeError('400 bad request'))

    run = UnansweredRun()
    assert run.failed(ModelTimeout('x')) is False
    run.answered()
    assert run.failed(down) is False
    assert run.failed(RuntimeError('an answer, if a bad one')) is False
    assert run.failed(ModelTimeout('x')) is False
    assert run.failed(down) is True
    assert run.stop_line(38) == ('The model did not answer 2 sentences in a row, so the run '
                                 'stopped. 38 sentences were not drafted.')
    assert run.stop_line(1, verb='glossed').endswith('1 sentence was not glossed.')
    # The last two sentences unanswered: nothing was left, so nothing stopped.
    assert run.stop_line(0) == ''


def test_one_retry_loop_decides_for_every_caller_of_a_model(no_sleep):
    """`retrying` is the loop the model services and the assistants share
    (R1-DEBT-CORE-15): the assistants had two copies of it, detecting a
    timeout two different ways."""
    fake = types.SimpleNamespace(RateLimitError=_RateLimited, Timeout=_Timeout)
    replies = [_RateLimited('slow'), _Timeout('late'), 'done']
    retried = []

    def call():
        r = replies.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    assert llm.retrying(call, model='m', litellm=fake, on_retry=lambda: retried.append(1)) == 'done'
    assert len(retried) == 2 and len(no_sleep) == 2
    # A caller that tries no timeout again sees the first one as it is.
    with pytest.raises(_Timeout):
        llm.retrying(lambda: (_ for _ in ()).throw(_Timeout('late')), model='m', litellm=fake,
                     timeout_retries=0)
    # Anything else is never tried again.
    calls = []
    with pytest.raises(ValueError):
        llm.retrying(lambda: calls.append(1) or (_ for _ in ()).throw(ValueError('bad request')),
                     model='m', litellm=fake)
    assert len(calls) == 1
    assert llm.is_timeout(_Timeout('late'), fake) and not llm.is_timeout(_RateLimited('x'), fake)
    assert llm.transient_errors(fake) == (_RateLimited,)


# --- streaming (H39-AGENT-UMR-1) ------------------------------------------------

def _chunk(content=None, finish_reason=None, reasoning=None, usage=None):
    delta = types.SimpleNamespace(content=content, reasoning_content=reasoning)
    choice = types.SimpleNamespace(delta=delta, finish_reason=finish_reason)
    return types.SimpleNamespace(choices=[choice], usage=usage)


class _Stream:
    """A provider's stream: yields its chunks, and records being closed."""

    def __init__(self, chunks, between=None):
        self.chunks = list(chunks)
        self.between = between
        self.closed = False
        self.read = 0

    def __iter__(self):
        for chunk in self.chunks:
            if self.closed:
                return
            if self.between and self.read:
                self.between()
            self.read += 1
            yield chunk

    def close(self):
        self.closed = True


def test_every_call_is_streamed_and_read_back_as_one_reply(monkeypatch):
    # A reasoning model thinks for minutes before it writes a word. Unstreamed,
    # the whole of it had to arrive inside --timeout, and no sentence did.
    stream = _Stream([_chunk(reasoning='Hmm. '), _chunk(reasoning='The root is go-01.'),
                      _chunk('(s1g / go-01'), _chunk(')'), _chunk(finish_reason='stop'),
                      types.SimpleNamespace(choices=[], usage=_Usage(40, 900))])
    fake = _fake_litellm([stream])
    _install(monkeypatch, fake)
    model = llm.ChatModel('openai/x')
    reply = model.complete('sys', 'user')
    assert fake.calls[0]['stream'] is True
    assert reply.text == '(s1g / go-01)' and reply.truncated is False
    assert reply.usage == {'prompt_tokens': 40, 'completion_tokens': 900}
    assert '40 prompt + 900 completion tokens' in model.usage_line()


def test_a_streamed_reply_cut_off_at_the_token_limit_says_so(monkeypatch):
    _install(monkeypatch, _fake_litellm([_Stream([_chunk('(s1g / go'), _chunk(finish_reason='length')])]))
    reply = llm.ChatModel('openai/x').complete('sys', 'user')
    assert reply.truncated is True and reply.text == '(s1g / go'


def test_a_stop_closes_the_stream_at_its_next_chunk(monkeypatch):
    # Closing the stream is what ends the request at the provider: a stopped
    # run must not leave the model thinking in a slot for minutes.
    monkeypatch.setattr(llm, 'STOP_POLL_S', 0.01)
    stop = {'asked': False}
    gate = threading.Event()

    def between():
        stop['asked'] = True
        gate.wait(0.5)

    stream = _Stream([_chunk(reasoning='a')] * 50, between=between)
    _install(monkeypatch, _fake_litellm([stream]))
    with pytest.raises(ServiceCancelled):
        llm.ChatModel('openai/x').complete('sys', 'user', should_stop=lambda: stop['asked'])
    gate.set()
    deadline = time.monotonic() + 2
    while not stream.closed and time.monotonic() < deadline:
        time.sleep(0.01)
    assert stream.closed and stream.read < 50


def test_a_timeout_in_the_middle_of_a_stream_is_tried_once_more(monkeypatch, no_sleep):
    class _Broken(_Stream):
        def __iter__(self):
            yield _chunk(reasoning='thinking')
            raise _Timeout('read timed out')

    fake = _fake_litellm([_Broken([]), _Stream([_chunk('ok'), _chunk(finish_reason='stop')])])
    _install(monkeypatch, fake)
    assert llm.ChatModel('openai/x').complete('sys', 'user').text == 'ok'
    assert len(fake.calls) == 2


def test_the_temperature_is_the_providers_unless_the_operator_sets_one(monkeypatch):
    # Greedy decoding sent a reasoning model round the same lines until its
    # token limit (51,000 tokens and counting at temperature 0).
    fake = _fake_litellm([_response('a'), _response('b')])
    _install(monkeypatch, fake)
    llm.ChatModel('openai/x').complete('sys', 'user')
    llm.ChatModel('openai/x', temperature=0.6).complete('sys', 'user')
    assert 'temperature' not in fake.calls[0]
    assert fake.calls[1]['temperature'] == 0.6
    parser = argparse.ArgumentParser()
    llm.add_model_arguments(parser)
    assert parser.parse_args(['--model', 'm']).temperature is None
    assert parser.parse_args(['--model', 'm', '--temperature', '0']).temperature == 0.0


def test_the_deadline_is_a_silence_not_the_length_of_the_reply():
    """Through the real litellm and openai SDK against a local server that
    streams for three times the deadline, one chunk at a time: the reply is
    whole. A server that then goes silent for longer than the deadline is a
    timeout."""
    litellm = pytest.importorskip('litellm')
    import http.server
    import json as _json

    class Handler(http.server.BaseHTTPRequestHandler):
        silent = False

        def log_message(self, *a):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers.get('Content-Length') or 0))
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()

            def send(delta, finish=None):
                body = {'id': 'c', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'x',
                        'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                self.wfile.write(f'data: {_json.dumps(body)}\n\n'.encode())
                self.wfile.flush()

            if Handler.silent:
                time.sleep(2.5)
                return
            for i in range(12):
                send({'reasoning_content': f'step {i}. '})
                time.sleep(0.25)
            send({'content': 'done'})
            send({}, 'stop')
            self.wfile.write(b'data: [DONE]\n\n')

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_address[1]}/v1'
    try:
        model = llm.ChatModel('openai/x', api_base=base, api_key='k', timeout=1)
        began = time.monotonic()
        assert model.complete('sys', 'user').text == 'done'
        assert time.monotonic() - began > 2.5
        Handler.silent = True
        with pytest.raises(llm.ModelTimeout):
            llm.ChatModel('openai/x', api_base=base, api_key='k', timeout=1).complete('sys', 'user')
    finally:
        server.shutdown()
    assert litellm  # imported for real, not the fake
