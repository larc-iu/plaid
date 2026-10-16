"""A respelling carried into the lexicon renames, at approval, the headwords
it renamed when it was staged: never an entry a merge or a delete earlier in
the same plan takes away (OPEN.md, FX-D-AGENT)."""
from live import live_client, seed  # noqa: F401
from fixtures import lexicon_raw, VOCAB
from rule_plan_model import approve, project
from test_rule_restate_live import _doc

from plaid_agent.igt.project import load_project
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace


def _forms(c, pid):
    ws = Workspace(c, load_project(c, pid))
    return sorted((it['id'], it['form']) for v in ws.project.vocabs for it in ws.lexicon(v))


def test_a_respelling_after_a_merge_renames_only_the_entry_that_stays(live_client):
    c = live_client
    s = seed(c, project(), {'d0': _doc('d0', 'Doc A', [('gam', '', [('gam', '')]), ('to', '', [('to', '')])])},
             {VOCAB: lexicon_raw()}, name='respell after merge')
    try:
        ws = Workspace(c, load_project(c, s.project_id))
        out = call_tool(ws, 'merge_entries', {'keep_form': 'gam#1', 'remove_form': 'gam#2'})
        assert not out.startswith('Error'), out
        out = call_tool(ws, 'respell_all', {'pattern': 'gam', 'replacement': 'gham', 'whole': True})
        assert not out.startswith('Error'), out
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        forms = _forms(c, s.project_id)
        assert [f for _i, f in forms].count('gham') == 1 and 'gam' not in [f for _i, f in forms], forms
    finally:
        s.delete()


def test_a_merge_planned_after_the_respelling_is_found_the_same_at_approval(live_client):
    # The respelling renames both entries when staged, and a merge after it
    # leaves it as it was found: approval drops the rename of the entry the
    # merge removes.
    c = live_client
    s = seed(c, project(), {'d0': _doc('d0', 'Doc A', [('gam', '', [('gam', '')]), ('to', '', [('to', '')])])},
             {VOCAB: lexicon_raw()}, name='respell before merge')
    try:
        ws = Workspace(c, load_project(c, s.project_id))
        out = call_tool(ws, 'respell_all', {'pattern': 'gam', 'replacement': 'gham', 'whole': True})
        assert not out.startswith('Error'), out
        out = call_tool(ws, 'merge_entries', {'keep_form': 'gam#1', 'remove_form': 'gam#2'})
        assert not out.startswith('Error'), out
        ws.plan_view()
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        forms = [f for _i, f in _forms(c, s.project_id)]
        assert forms.count('gham') == 1 and 'gam' not in forms, forms
    finally:
        s.delete()
