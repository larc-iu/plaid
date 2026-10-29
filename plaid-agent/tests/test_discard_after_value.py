"""A value planned on a word and then a discard of that word's unverified
analysis in the same plan: the discard deletes the machine span the value was
planned on, so the value is taken out of the plan as the discard is staged.
Approval used to answer "404 Spans not found" with nothing written (REV-FX-R1)."""
import pytest

from igt_rules_live import base_project, seeded, workspace
from live import live_client  # noqa: F401
from rule_plan_model import approve
from test_rule_restate_live import _doc

from plaid_agent.igt.toolkit import call_tool


def _docs():
    d = _doc('d0', 'Doc A', [('aa', 'A', [('aa', '')]), ('bb', 'B', [('bb', '')])])
    for sp in d['text_layers'][0]['token_layers'][1]['span_layers'][0]['spans']:
        sp['metadata'] = {'prov': 'inferred', 'provSource': 'service:x'}
    return [d]


@pytest.mark.parametrize('value_first', [True, False])
def test_a_discard_beside_a_value_on_the_same_word_applies(live_client, value_first):
    c = live_client
    s, ws = seeded(c, base_project(), _docs(), name=f'discard after value {value_first}')
    try:
        steps = [('set_field', {'document': 'Doc A', 'refs': ['s1.w2'], 'field': 'Gloss', 'value': 'X'}),
                 ('discard_analysis', {'document': 'Doc A', 'refs': ['s1.w2']})]
        said = [call_tool(ws, tool, args) for tool, args in (steps if value_first else steps[::-1])]
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, (said, h.errors)
        w = workspace(c, s).doc('Doc A').sentences[0].words[1]
        if value_first:
            # The discard came last and took the planned value out.
            assert 'taken out' in said[1] and 'Gloss' not in w.fields, (said, w.fields)
        else:
            # The value came last, over a discarded machine value: it stands.
            assert w.fields['Gloss'].value == 'X', (said, w.fields)
    finally:
        s.delete()
