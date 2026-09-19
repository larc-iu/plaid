"""Every tool that can add to a plan reaches the refusals a plan owes.

A guard written once, in a helper, and reached by only some of its callers is
the failure this package has had most often: the tests cover the guarded path
and pass, so the hole is invisible. These sweep the whole tool table instead of
naming the tools somebody remembered.
"""

import sys

import pytest

sys.path.insert(0, 'tests')

from plaid_agent.igt.toolkit import WRITE_TOOLS as IGT_WRITE, call_tool as igt_call  # noqa: E402
from plaid_agent.ud.toolkit import WRITE_TOOLS as UD_WRITE, call_tool as ud_call  # noqa: E402

# Enough of each tool's arguments to get past its own argument checks and reach
# the plan. A tool that refuses for some other reason is still a pass: what is
# asserted is that nothing joins the plan, not which sentence comes back.
IGT_ARGS = {'document': 'Text 1', 'ref': 's1.w1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'x',
            'pattern': 'gam', 'replacement': 'y', 'form': 'gam', 'new_form': 'z', 'name': 'New',
            'text': 'a b c', 'body': 'a note', 'as_of': '2026-01-01T00:00:00Z', 'at': 2,
            'before_word': 2, 'entry_form': 'gam', 'keep_form': 'gam', 'remove_form': 'Ali',
            'morphemes': [{'form': 'gam'}], 'sequence': [{'Gloss': 'ERG'}], 'indexes': [1],
            'orthography': 'IPA', 'target': 'IPA', 'source': 'baseline', 'forms': ['a', 'b'],
            'gloss': 'fish', 'number': 1, 'index': 0, 'type': 'stem', 'entry_id': 'vi-gam',
            'documents': ['all'], 'fields': {'gloss': 'x'}, 'order': ['1', '2'], 'new_name': 'Renamed'}
UD_ARGS = {'document': 'Viaje', 'ref': 's1.w2', 'refs': ['s1.w2'], 'field': 'lemma', 'value': 'x',
           'pattern': 'mar', 'replacement': 'y', 'head': 1, 'deprel': 'obj', 'feature': 'Number',
           'body': 'a note', 'as_of': '2026-01-01T00:00:00Z', 'forms': ['a', 'b'],
           'documents': ['Viaje'], 'language': 'es', 'indexes': [1]}

# Where the shared values above do not reach the plan (a reference of the
# wrong shape, an entry that needs telling apart from its homograph).
IGT_OVERRIDES = {
    'respell': {'ref': 's1.w1', 'new_text': 'Ali-du'},
    'set_morpheme': {'ref': 's1.w1.m1', 'form': 'Ali'},
    'merge_sentences': {'ref': 's2'},
    'split_sentence': {'ref': 's1', 'before_word': 2},
    'retype_sentence': {'ref': 's1', 'text': 'Ali-di gam akuna.'},
    'merge_words': {'refs': ['s1.w1', 's1.w2']},
    'link_phrase': {'refs': ['s1.w1', 's1.w2']},
    'unlink_phrase': {'refs': ['s1.w2', 's1.w3']},
    'make_sense_of': {'under_id': 'vi-ali', 'entry_id': 'vi-gam'},
    'free_sense': {'entry_id': 'vi-gam'},
    'move_sense': {'entry_id': 'vi-gam', 'number': 1},
    'remove_example': {'entry_id': 'vi-gam', 'index': 0},
    'merge_entries': {'keep_id': 'vi-gam', 'remove_id': 'vi-ali'},
    'set_document_metadata': {'field': 'Date', 'value': '2021'},
    'confirm': {'documents': ['all']},
}
UD_OVERRIDES = {}

IGT_RESTORE = {'kind': 'restore_document', 'document_id': 'd1', 'as_of': '2026-01-01T00:00:00Z',
               'doc': 'd1', 'label': 'Text 1: restore'}
UD_RESTORE = {'kind': 'restore_document', 'document_id': 'ud1', 'as_of': '2026-01-01T00:00:00Z',
              'label': 'restore "Viaje"'}


def _igt_ws():
    from fixtures import project_raw, document_raw, lexicon_raw
    from fixtures_ext import ExtClient
    from plaid_agent.igt.project import load_project
    from plaid_agent.igt.workspace import Workspace
    c = ExtClient(project=project_raw(), documents={'d1': document_raw()}, lexicon=lexicon_raw())
    w = Workspace(c, load_project(c, 'p1'))
    w.prefer_scan = True
    return w


def _ud_ws():
    from ud_fixtures import PID, ExtClient, project_raw, document_raw
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.tools import Workspace
    c = ExtClient(project=project_raw(), documents={'ud1': document_raw()})
    return Workspace(c, load_project(c, PID))


def _args(tool, tools, values, overrides):
    spec = next(t['function'] for t in tools if t['function']['name'] == tool)
    props = (spec.get('parameters') or {}).get('properties') or {}
    return {**{k: values[k] for k in props if k in values}, **overrides.get(tool, {})}


def _write_tools(app):
    if app == 'igt':
        from plaid_agent.igt.toolkit import TOOLS
        return sorted(IGT_WRITE), TOOLS
    from plaid_agent.ud.toolkit import TOOLS
    return sorted(UD_WRITE), TOOLS


IGT_TOOLS, IGT_TABLE = _write_tools('igt')
UD_TOOLS, UD_TABLE = _write_tools('ud')

# A tool that only ever takes changes OUT of the plan. It is a write tool by
# the table's reckoning (its description starts with PLAN:), and refusing it
# beside a restore would leave the model no way to drop the restore.
TAKES_AWAY = {'discard_plan', 'drop_planned'}


@pytest.mark.parametrize('tool', IGT_TOOLS, ids=IGT_TOOLS)
def test_no_igt_tool_joins_a_plan_that_holds_a_restore(tool):
    if tool in TAKES_AWAY:
        pytest.skip('it only removes changes')
    ws = _igt_ws()
    ws.ops.append(dict(IGT_RESTORE))
    igt_call(ws, tool, _args(tool, IGT_TABLE, IGT_ARGS, IGT_OVERRIDES))
    assert ws.ops == [IGT_RESTORE], f'{tool} added to a plan holding a restore'


@pytest.mark.parametrize('tool', UD_TOOLS, ids=UD_TOOLS)
def test_no_ud_tool_joins_a_plan_that_holds_a_restore(tool):
    if tool in TAKES_AWAY:
        pytest.skip('it only removes changes')
    ws = _ud_ws()
    ws.ops.append(dict(UD_RESTORE))
    ud_call(ws, tool, _args(tool, UD_TABLE, UD_ARGS, UD_OVERRIDES))
    assert ws.ops == [UD_RESTORE], f'{tool} added to a plan holding a restore'


# UMR has no restore tool, so the two restore tests below run for the apps
# that have one. Listing umr here would run UD's branch under umr's name.
@pytest.mark.parametrize('app', ['igt', 'ud'])
def test_a_restore_does_not_join_a_plan_that_holds_anything(app):
    """The other half of the same rule. It used to live in the restore tool
    rather than in the funnel, so a second kind that owns its plan would have
    got one half by being declared and the other not at all."""
    ws, call = (_igt_ws(), igt_call) if app == 'igt' else (_ud_ws(), ud_call)
    ws.ops.append({'kind': 'set_span', 'layer_id': 'L', 'token_id': 'T', 'value': 'x', 'label': 'a value'})
    before = list(ws.ops)
    doc = 'Text 1' if app == 'igt' else 'Viaje'
    out = call(ws, 'restore_document', {'document': doc, 'as_of': '2026-01-01T00:00:00Z'})
    assert out.startswith('Error:') and 'plan of its own' in out
    assert ws.ops == before


def _restoring_ws(app):
    """A workspace whose server answers a restore dry run, so the tool really
    stages one (the fixtures above report nothing to restore)."""
    if app == 'igt':
        from fixtures import FakeClient, scan_ws
        return scan_ws(FakeClient()), igt_call, 'Text 1'
    from ud_fixtures import PID, ud_client
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.tools import Workspace
    c = ud_client()
    return Workspace(c, load_project(c, PID)), ud_call, 'Viaje'


@pytest.mark.parametrize('app', ['igt', 'ud'])
def test_a_second_restore_of_one_document_replaces_the_first(app):
    """The same gesture answered differently in the two apps. Both restore
    tools asked the funnel WITHOUT the op they were about to stage, so the
    early question was stricter than the real one: IGT refused a re-planned
    restore its own registry says SUPERSEDES the first, and UD's registry
    named no target at all, so a model correcting an as_of it had just planned
    had to discard the plan to do it."""
    ws, call, doc = _restoring_ws(app)
    first = call(ws, 'restore_document', {'document': doc, 'as_of': '2026-09-05T18:45:49Z'})
    assert not first.startswith('Error:'), first
    second = call(ws, 'restore_document', {'document': doc, 'as_of': '2026-09-06T09:00:00Z'})
    assert not second.startswith('Error:'), second
    assert [op['kind'] for op in ws.ops] == ['restore_document']
    assert ws.ops[0]['as_of'] == '2026-09-06T09:00:00Z'
    # And the exclusivity still holds: nothing else joins the plan it owns.
    out = call(ws, 'add_comment', {'document': doc, 'ref': 's1', 'body': 'a note'})
    assert out.startswith('Error:') and len(ws.ops) == 1


def test_the_sweep_found_the_write_tools():
    """Without this both sweeps are green on an empty tool list."""
    assert len(IGT_TOOLS) >= 30 and len(UD_TOOLS) >= 10
    assert 'restore_document' in IGT_TOOLS and 'restore_document' in UD_TOOLS


def _reached(app):
    """The write tools whose refusal is the one the funnel makes, rather than
    an argument check they never got past."""
    if app == 'igt':
        tools, table, args, over, ws_of, call = IGT_TOOLS, IGT_TABLE, IGT_ARGS, IGT_OVERRIDES, _igt_ws, igt_call
        restore, phrase = IGT_RESTORE, 'holds a restore'
    else:
        tools, table, args, over, ws_of, call = UD_TOOLS, UD_TABLE, UD_ARGS, UD_OVERRIDES, _ud_ws, ud_call
        restore, phrase = UD_RESTORE, 'restores a document'
    out = []
    for tool in tools:
        if tool in TAKES_AWAY:
            continue
        ws = ws_of()
        ws.ops.append(dict(restore))
        if phrase in call(ws, tool, _args(tool, table, args, over)):
            out.append(tool)
    return out


@pytest.mark.parametrize('app,floor', [('igt', 30), ('ud', 11)])
def test_most_write_tools_are_refused_by_the_funnel_itself(app, floor):
    """The sweep above passes for a tool that refused its own arguments and
    never reached the plan at all, so this counts the ones that really got
    there. A drop means the arguments above stopped reaching the plan, and the
    sweep stopped proving anything about those tools."""
    reached = _reached(app)
    assert len(reached) >= floor, f'only {len(reached)} of {app}\'s write tools reached the guard: {reached}'
