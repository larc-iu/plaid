"""A step label names a document by its name where the model passed its id,
as the plan card does (H17-ASSIST polish: 'on 2 items in “01a0c39e-…”')."""

import sys

sys.path.insert(0, 'tests')

from plaid_agent.core import agent
from test_nothing_planned import _igt, _reply, _run


def test_a_plan_step_on_a_document_named_by_id_says_its_name(monkeypatch):
    ws, kit, _plan, _read = _igt()
    did = ws.resolve_document_id('Text 1')
    out, _sent = _run(monkeypatch, ws, kit, [
        _reply(('set_field', {'document': did, 'refs': ['s1.w1', 's1.w2'], 'field': 'Gloss', 'value': 'X'})),
        _reply(text='Planned it.'),
    ])
    label = out.steps[0]['label']
    assert '“Text 1”' in label and did not in label, label


def test_a_read_held_to_documents_by_id_says_their_names(monkeypatch):
    ws, kit, _plan, _read = _igt()
    did = ws.resolve_document_id('Text 1')
    out, _sent = _run(monkeypatch, ws, kit, [
        _reply(('corpus_stats', {'document': did})),
        _reply(text='Done.'),
    ])
    label = out.steps[0]['label']
    assert '“Text 1”' in label and did not in label, label


def test_named_args_leaves_a_name_and_other_arguments_alone():
    ws, _kit, _plan, _read = _igt()
    did = ws.resolve_document_id('Text 1')
    assert agent.named_args(ws, {'document': 'Text 1', 'refs': [did]}) == {'document': 'Text 1', 'refs': [did]}
    assert agent.named_args(ws, {'documents': [did, 'nope']}) == {'documents': ['Text 1', 'nope']}
