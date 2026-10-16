"""A respelling carried into the lexicon renames, at approval, the headwords
it renamed when it was staged: never an entry a merge or a delete earlier in
the same plan takes away (OPEN.md, FX-D-AGENT)."""
import pytest

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


_BEFORE = {'merge': ('merge_entries', {'keep_form': 'gam#1', 'remove_form': 'gam#2'}),
           'delete': ('delete_entry', {'entry_form': 'gam#2'}),
           'replace_rule': ('replace_in_field', {'field': 'Gloss', 'pattern': 'G', 'replacement': 'H'}),
           'gloss_rule': ('set_field_for_form', {'form': 'mi', 'field': 'Gloss', 'value': 'T', 'only_empty': False})}


@pytest.mark.parametrize('before', sorted(_BEFORE))
@pytest.mark.parametrize('then', ['drop', 'reask', 'keep'])
def test_a_change_before_a_respelling_dropped_asked_again_or_kept_leaves_the_plan_whole(live_client, before, then):
    # The respelling found again reads only the corpus-wide changes before
    # it, never itself: it was refused as "a corpus-wide change that reaches
    # this document", the entry dropped all the same, and the turn's plan
    # could not be packaged (REV7-PLAN-1).
    c = live_client
    s = seed(c, project(), {'d0': _doc('d0', 'Doc A', [('gam', 'G', [('gam', '')]), ('to', '', [('to', '')])]),
                            'd1': _doc('d1', 'Doc B', [('mi', 'G', [('mi', '')])])},
             {VOCAB: lexicon_raw()}, name=f'respell after {before} {then}')
    try:
        ws = Workspace(c, load_project(c, s.project_id))
        tool, args = _BEFORE[before]
        out = call_tool(ws, tool, args)
        assert not out.startswith('Error'), out
        out = call_tool(ws, 'respell_all', {'pattern': 'gam', 'replacement': 'gham', 'whole': True})
        assert not out.startswith('Error'), out
        if then == 'drop':
            out = call_tool(ws, 'drop_planned', {'indexes': [1]})
        elif then == 'reask':
            if not tool.endswith(('_field', '_form')):
                pytest.skip('a merge or a delete asked again is refused: its entry is gone already')
            out = call_tool(ws, tool, args)
        else:
            out = call_tool(ws, 'set_field', {'document': 'Doc A', 'refs': ['s1.w1'], 'field': 'Gloss',
                                              'value': 'G'})
        assert not out.startswith('Error'), out
        assert not call_tool(ws, 'plan_status', {}).startswith('Error')
        assert any(o.get('tool') == 'respell_all' for o in ws.ops)
        assert ws.plan_payload() is not None
        _p, h, _ = approve(c, s.project_id, ws)
        assert not h.errors, h.errors
        forms = [f for _i, f in _forms(c, s.project_id)]
        assert 'gam' not in forms and 'gham' in forms, forms
    finally:
        s.delete()
