"""The note approval writes for a change a corpus-wide rule found on a stored
morpheme that a planned analysis replaces: the analysis replaces it, whatever
else the plan deletes (FX-F-AGENT, older)."""
from live import live_client, seed  # noqa: F401
from fixtures import lexicon_raw, VOCAB
from rule_plan_model import approve, project
from test_rule_restate_live import _doc

from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace


def test_a_rules_change_on_a_morpheme_an_analysis_replaces_is_noted_as_replaced(live_client):
    c = live_client
    docs = {'d0': _doc('d0', 'Doc A', [('ka', '', [('ka', '')]), ('kan', '', [('ka', ''), ('n', '')]),
                                       ('nu', '', [('n', '')])])}
    s = seed(c, project(), docs, {VOCAB: lexicon_raw()}, name='moot note')
    try:
        ws = Workspace(c, load_project(c, s.project_id))
        call_tool(ws, 'set_analysis', {'document': 'Doc A', 'ref': 's1.w2', 'morphemes': [{'form': 'kan'}]})
        call_tool(ws, 'set_field_for_form', {'form': 'ka', 'field': 'Morph Gloss', 'value': 'X', 'only_empty': False})
        call_tool(ws, 'set_field_for_form', {'form': 'n', 'field': 'Morph Gloss', 'value': 'Y', 'only_empty': False})
        _p, h, store = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        said = ' '.join(d.get('message') or '' for d in h.done)
        assert 'deletes what it writes to' not in said, said
        assert said.count('(an analysis the plan writes replaces it)') == 2, said
    finally:
        s.delete()
