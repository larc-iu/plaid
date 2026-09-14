"""Tests for the chat model both LLM services now share.

litellm is never imported here: the module imports it inside the call, and a
fake stands in for it. Run::

    cd plaid-client-py && python -m pytest tests/ -q
"""

import os
import sys
import types

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.workflows import llm  # noqa: E402


class _RateLimited(Exception):
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
                                 RateLimitError=_RateLimited)
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
    assert model.describe() == {'model': 'openai/x', 'api_base': 'http://gpu:8000/v1'}


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


def test_setup_service_takes_the_operators_identity_overrides():
    class _Service:
        service_name = 'LLM glossing'
        service_id = 'llm-analyzer'
        REQUEST_SECRETS = ()

    args = types.SimpleNamespace(model='ollama/llama3.1', api_base=None, api_key='sk-flag',
                                 temperature=0.0, max_tokens=None,
                                 service_id='llm-analyzer-llama', service_name=None)
    svc = _Service()
    model = llm.setup_service(svc, args)
    assert svc.model is model and model.model == 'ollama/llama3.1'
    assert svc.service_id == 'llm-analyzer-llama'
    assert svc.service_name == 'LLM glossing (ollama/llama3.1)'
    assert 'sk-flag' in svc.REQUEST_SECRETS
