"""The trace counts the documents a read was held to as they resolved
(core/scope.py), each once: a document named by its id and by its name is
one document in both apps, through the turn's own loop (core/agent.py)."""

import json

from fixtures import FakeClient, fake_ws
from test_turn_failures import Script, _call, _resp
from live import live_client  # noqa: F401 - fixture
from test_ud_read_scope import ws as ud_ws  # noqa: F401 - fixture

from plaid_agent.core import agent
from plaid_agent.core.agent import ModelConfig, run_turn
from plaid_agent.core.agent import Toolkit


def _traced(monkeypatch, toolkit, tracer, ws, name, args):
    script = Script(_resp(calls=[_call(1, name, json.dumps(args))]), _resp('Done.'))
    monkeypatch.setattr(agent.litellm, 'completion', script)
    kit = Toolkit(tools_for=toolkit.tools_for, call_tool=toolkit.call_tool, tracer=tracer)
    turn = run_turn(ModelConfig(model='fake/m', stream=False), kit, ws, 'system',
                    [{'role': 'user', 'content': 'hi'}])
    [step] = turn.steps
    assert not step.get('failed'), step
    return step['label']


def test_igt_an_id_and_a_name_of_one_document_trace_as_one(monkeypatch):
    from plaid_agent.igt import toolkit
    from plaid_agent.igt.trace import TRACER
    w = fake_ws(FakeClient())
    name = w.corpus.doc_name('d1')
    label = _traced(monkeypatch, toolkit, TRACER, w, 'frequency_list', {'documents': ['d1', name]})
    assert f' in “{name}”' in label, label
    assert 'documents' not in label, label
    assert w.scoped_documents is None


def test_ud_an_id_and_a_name_of_one_document_trace_as_one(monkeypatch, ud_ws):
    from plaid_agent.ud import toolkit
    from plaid_agent.ud.trace import TRACER
    uno = next(d['id'] for d in ud_ws.documents() if d.get('name') == 'Uno')
    label = _traced(monkeypatch, toolkit, TRACER, ud_ws, 'frequency_list',
                    {'what': 'upos', 'documents': [uno, 'Uno']})
    assert label.startswith('Ranked UPOS tags by frequency in “Uno”'), label
    label = _traced(monkeypatch, toolkit, TRACER, ud_ws, 'frequency_list',
                    {'what': 'upos', 'documents': [uno, 'Uno', 'Dos']})
    assert label.startswith('Ranked UPOS tags by frequency in 2 documents'), label
