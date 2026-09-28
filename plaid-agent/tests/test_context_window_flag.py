"""The operator states the model's context window (ruling umr-assist-context-window).

A model litellm has no record of shows its count with no percentage, by an
earlier ruling, because a guessed denominator reads as a measurement. The
default deployment's model is one of those, so its 85 percent warning never
fired. ``--context-window N`` is the operator stating the figure: it is used
as it stands, over litellm's, and nothing is guessed when it is absent.
"""

import argparse

import pytest

from fixtures import FakeClient

from plaid_agent.core import service as service_mod
from plaid_agent.core.agent import ModelConfig, TurnResult, context_window
from test_service_flow import Helper, _request, _seed, _service

UNKNOWN = 'some-proxy/model-nobody-has-heard-of'


def test_a_stated_window_is_used_for_a_model_litellm_does_not_know():
    assert context_window(UNKNOWN) is None
    assert context_window(UNKNOWN, 131072) == 131072


def test_a_stated_window_wins_over_litellms_figure():
    assert context_window('gpt-4o-mini') not in (None, 5000)
    assert context_window('gpt-4o-mini', 5000) == 5000


def _parser():
    parser = argparse.ArgumentParser()
    _service().add_arguments(parser)
    return parser


def test_the_flag_takes_a_positive_whole_number():
    args = _parser().parse_args(['--model', UNKNOWN, '--context-window', '131072'])
    assert args.context_window == 131072
    assert _parser().parse_args(['--model', UNKNOWN]).context_window is None
    for bad in ('0', '-5', 'lots', '1.5'):
        with pytest.raises(SystemExit):
            _parser().parse_args(['--model', UNKNOWN, '--context-window', bad])


def test_setup_carries_the_flag_into_the_model_config(monkeypatch, capsys):
    monkeypatch.setattr(service_mod, 'ping_model', lambda cfg: None)
    svc = _service()
    svc.setup(_parser().parse_args(['--model', UNKNOWN, '--context-window', '131072']))
    assert svc.cfg.context_window == 131072
    assert 'Context window: 131072 tokens (--context-window)' in capsys.readouterr().out


def test_setup_says_when_the_window_is_unknown(monkeypatch, capsys):
    monkeypatch.setattr(service_mod, 'ping_model', lambda cfg: None)
    svc = _service()
    svc.setup(_parser().parse_args(['--model', UNKNOWN]))
    assert svc.cfg.context_window is None
    out = capsys.readouterr().out
    assert 'Context window: unknown' in out and '--context-window' in out


@pytest.mark.parametrize('stated, window', [(131072, 131072), (None, None)])
def test_the_turn_records_the_stated_window_beside_its_usage(monkeypatch, stated, window):
    client = FakeClient()
    store = _seed(client)

    def fake_run_turn(cfg, kit, ws, system, transcript, on_progress, cancelled, on_text=None):
        return TurnResult('Two words.', [{'role': 'assistant', 'content': 'Two words.'}], [],
                          usage={'sent': 1000, 'received': 20})

    monkeypatch.setattr(service_mod, 'run_turn', fake_run_turn)
    svc = _service()
    svc.cfg = ModelConfig(model=UNKNOWN, context_window=stated)
    helper = Helper()
    svc.process_request(_request(client), helper)
    assert not helper.errors, helper.errors
    conv, _meta = store.load('c1')
    usage = conv['display'][-1]['usage']
    assert usage['sent'] == 1000
    assert usage.get('window') == window


def test_the_transcript_budget_is_the_windows_share_less_the_prompt_and_tools():
    from plaid_agent.core.limits import TRANSCRIPT_WINDOW_SHARE

    svc = _service()
    svc.cfg = ModelConfig(model=UNKNOWN, context_window=100_000)
    tokens, measure = svc.transcript_budget(UNKNOWN, ('system prompt', [{'name': 'tool'}]))
    assert tokens == int(100_000 * TRANSCRIPT_WINDOW_SHARE) - measure(('system prompt', [{'name': 'tool'}]))
    assert measure('hello world') > 0
    # No window known: no token budget (prune falls back to bytes).
    svc.cfg = ModelConfig(model=UNKNOWN)
    assert svc.transcript_budget(UNKNOWN, ('s', [])) is None
