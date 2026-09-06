"""The model side: the startup ping, and the call shape every request shares."""

import argparse
from types import SimpleNamespace

import pytest

from plaid_igt_agent import agent
from plaid_igt_agent.agent import ModelConfig, ping_model


def cfg(**kw):
    return ModelConfig(model='openai/x', **kw)


def test_ping_asks_the_configured_model_with_the_operators_base_and_key(monkeypatch):
    seen = {}

    def fake(**kwargs):
        seen.update(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace()])

    monkeypatch.setattr(agent.litellm, 'completion', fake)
    ping_model(cfg(api_base='http://gpu-box:8000/v1', api_key='k'), timeout=5)
    assert (seen['model'], seen['api_base'], seen['api_key']) == ('openai/x', 'http://gpu-box:8000/v1', 'k')
    # Small and bounded: this is a knock on the door, not a conversation.
    assert seen['timeout'] == 5 and seen['max_tokens'] == 8 and len(seen['messages']) == 1

    # Nothing configured: litellm reads the provider's own environment.
    seen.clear()
    ping_model(cfg())
    assert 'api_base' not in seen and 'api_key' not in seen


def test_ping_fails_on_a_provider_error_or_an_empty_answer(monkeypatch):
    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: (_ for _ in ()).throw(RuntimeError('no key')))
    with pytest.raises(RuntimeError, match='no key'):
        ping_model(cfg())
    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: SimpleNamespace(choices=[]))
    with pytest.raises(RuntimeError, match='without a completion'):
        ping_model(cfg())


def service_args(**kw):
    base = dict(model='openai/x', api_base=None, api_key=None, max_steps=50, temperature=None,
                max_tokens=None, service_id=None, service_name=None, url='http://localhost:8085',
                web_search=None, web_search_key=None, web_search_url=None)
    return argparse.Namespace(**{**base, **kw})


def test_setup_stops_the_service_when_the_model_does_not_answer(monkeypatch, capsys):
    from plaid_igt_agent.service import AssistantService
    args = service_args()

    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: (_ for _ in ()).throw(RuntimeError('bad key')))
    with pytest.raises(SystemExit) as exc:
        AssistantService().setup(args)
    assert exc.value.code == 1 and 'bad key' in capsys.readouterr().out

    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: SimpleNamespace(choices=[SimpleNamespace()]))
    svc = AssistantService()
    svc.setup(args)  # answered: registration goes ahead
    assert svc.service_id == 'igt:assist:openai-x' and svc.extras['model'] == 'openai/x'
    assert svc.web_cfg is None and 'Web lookup: off' in capsys.readouterr().out


def test_setup_stops_the_service_when_the_search_provider_does_not_answer(monkeypatch, capsys):
    from plaid_igt_agent import service as service_mod
    from plaid_igt_agent.service import AssistantService
    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: SimpleNamespace(choices=[SimpleNamespace()]))

    # Asked for, but with no key anywhere.
    monkeypatch.delenv('BRAVE_SEARCH_API_KEY', raising=False)
    with pytest.raises(SystemExit) as exc:
        AssistantService().setup(service_args(web_search='brave'))
    assert exc.value.code == 1 and 'needs a key' in capsys.readouterr().out

    # Keyed, but the provider refuses.
    monkeypatch.setattr(service_mod, 'ping_search',
                        lambda cfg: (_ for _ in ()).throw(RuntimeError('rejected the key')))
    with pytest.raises(SystemExit) as exc:
        AssistantService().setup(service_args(web_search='brave', web_search_key='k'))
    assert exc.value.code == 1 and 'rejected the key' in capsys.readouterr().out

    # Keyed and answering: the Plaid host is denied to any fetch.
    monkeypatch.setattr(service_mod, 'ping_search', lambda cfg: 3)
    svc = AssistantService()
    svc.setup(service_args(web_search='brave', web_search_key='k', url='https://plaid.example.org'))
    assert svc.web_cfg.backend == 'brave' and svc.web_cfg.deny_hosts == ('plaid.example.org',)


def test_a_self_hosted_provider_wants_a_url_and_no_key(monkeypatch, capsys):
    from plaid_igt_agent import service as service_mod
    from plaid_igt_agent.service import AssistantService
    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: SimpleNamespace(choices=[SimpleNamespace()]))
    monkeypatch.setattr(service_mod, 'ping_search', lambda cfg: 2)

    # No key is needed, but it does need to be told where the instance is.
    with pytest.raises(SystemExit) as exc:
        AssistantService().setup(service_args(web_search='searxng'))
    assert exc.value.code == 1 and 'needs --web-search-url' in capsys.readouterr().out

    svc = AssistantService()
    svc.setup(service_args(web_search='searxng', web_search_url='http://localhost:8888'))
    assert (svc.web_cfg.backend, svc.web_cfg.api_key) == ('searxng', '')
    assert svc.web_cfg.api_base == 'http://localhost:8888'
    assert 'Web lookup: searxng at http://localhost:8888' in capsys.readouterr().out


# --- streaming ---------------------------------------------------------------


def _chunk(content=None):
    return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=content))])


def test_streaming_hands_out_the_text_so_far_and_rebuilds_the_response(monkeypatch):
    monkeypatch.setattr(agent, 'STREAM_INTERVAL_S', 0)
    seen_kwargs = {}

    def fake_completion(**kwargs):
        seen_kwargs.update(kwargs)
        return iter([_chunk('Hel'), _chunk(None), _chunk('lo'), _chunk(' world')])

    monkeypatch.setattr(agent.litellm, 'completion', fake_completion)
    monkeypatch.setattr(agent.litellm, 'stream_chunk_builder',
                        lambda chunks, messages=None: SimpleNamespace(rebuilt=len(chunks), messages=messages))
    texts = []
    cfg = agent.ModelConfig(model='m')
    out = agent._complete(cfg, {'model': 'm', 'messages': [{'role': 'user', 'content': 'hi'}]}, texts.append)
    assert seen_kwargs['stream'] is True
    assert texts[-1] == 'Hello world' and texts == sorted(texts, key=len), 'the whole text so far, growing'
    assert out.rebuilt == 4 and out.messages == [{'role': 'user', 'content': 'hi'}]


def test_streaming_is_off_when_configured_and_falls_back_when_the_provider_refuses(monkeypatch):
    calls = []

    def fake_completion(**kwargs):
        calls.append(kwargs.get('stream'))
        if kwargs.get('stream'):
            raise RuntimeError('streaming not supported')
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='whole', tool_calls=None))])

    monkeypatch.setattr(agent.litellm, 'completion', fake_completion)
    texts = []
    out = agent._complete(agent.ModelConfig(model='m', stream=False), {'model': 'm', 'messages': []}, texts.append)
    assert calls == [None] and out.choices[0].message.content == 'whole' and texts == []
    calls.clear()
    out = agent._complete(agent.ModelConfig(model='m'), {'model': 'm', 'messages': []}, texts.append)
    assert calls == [True, None], 'refused before the first chunk: asked again without streaming'
    assert out.choices[0].message.content == 'whole'


def test_a_whole_response_from_a_stream_call_is_taken_as_is(monkeypatch):
    whole = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='x', tool_calls=None))])
    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: whole)
    assert agent._complete(agent.ModelConfig(model='m'), {'model': 'm', 'messages': []}, lambda t: None) is whole
