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


def test_setup_stops_the_service_when_the_model_does_not_answer(monkeypatch, capsys):
    from plaid_igt_agent.service import AssistantService
    args = argparse.Namespace(model='openai/x', api_base=None, api_key=None, max_steps=50, temperature=None,
                              max_tokens=None, service_id=None, service_name=None)

    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: (_ for _ in ()).throw(RuntimeError('bad key')))
    with pytest.raises(SystemExit) as exc:
        AssistantService().setup(args)
    assert exc.value.code == 1 and 'bad key' in capsys.readouterr().out

    monkeypatch.setattr(agent.litellm, 'completion', lambda **kw: SimpleNamespace(choices=[SimpleNamespace()]))
    svc = AssistantService()
    svc.setup(args)  # answered: registration goes ahead
    assert svc.service_id == 'igt:assist:openai-x' and svc.extras['model'] == 'openai/x'
