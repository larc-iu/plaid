"""The tagsets tool, staged and then applied against a real server.

Setting up a tagset is rare, so the tool is one short schema whose ``help``
action carries the instructions. What approval writes is checked on a real core,
because a closed list is a rule core holds: the declaration goes in the batch
that writes the configuration, and stored values that break it refuse that batch.
"""

import pytest
from fixtures import project_raw, document_raw, lexicon_raw, VOCAB, MGLOSS, GLOSS, FakeClient
from live import live_client, seed  # noqa: F401 - fixture

from plaid_agent.core.plan import PlanError, PlanOutOfDate
from plaid_agent.core.tools import ToolError
from plaid_agent.igt import toolkit
from plaid_agent.igt.plan import execute_plan
from plaid_agent.igt.project import load_project
from plaid_agent.igt.tagsets import HELP, refusal_words, write_settings
from plaid_client import PlaidAPIError
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.workspace import Workspace


def test_the_schema_stays_small_and_help_carries_the_rest():
    schema = next(t for t in toolkit.TOOLS if t['function']['name'] == 'tagsets')
    assert len(schema['function']['description']) < 200
    assert 'tagsets' in toolkit.WRITE_TOOLS
    ws = Workspace(FakeClient(), load_project(FakeClient(), 'p1'))
    assert call_tool(ws, 'tagsets', {'action': 'help'}) == HELP
    assert ws.ops == []


def test_a_requester_who_maintains_nothing_is_refused_before_anything_is_planned():
    ws = Workspace(FakeClient(), load_project(FakeClient(), 'p1'))
    ws.requester_id = 'someone@x'
    ws.requester_is_admin = lambda: False
    out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'mode': 'closed'}})
    assert 'Only a maintainer of this project' in out and ws.ops == []


def test_edits_build_on_what_the_plan_already_holds():
    ws = Workspace(FakeClient(), load_project(FakeClient(), 'p1'))
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'POS', 'changes': {'add': ['n', {'value': 'v'}]}})
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'pos', 'changes': {'mode': 'closed', 'rename_to': 'Parts'}})
    call_tool(ws, 'tagsets', {'action': 'assign', 'field': 'Gloss', 'tagset': 'Parts'})
    tagset_ops = [op for op in ws.ops if op['kind'] == 'set_tagset']
    assert len(tagset_ops) == 1  # the second edit replaced the first
    op = tagset_ops[0]
    assert (op['was'], op['name'], op['before']) == ('POS', 'Parts', None)
    assert op['after']['mode'] == 'closed' and [v['value'] for v in op['after']['values']] == ['n', 'v']
    assign = next(op for op in ws.ops if op['kind'] == 'assign_tagset')
    assert (assign['key'], assign['before'], assign['after']) == (GLOSS, None, 'Parts')
    with pytest.raises(ToolError):
        from plaid_agent.igt.tagsets import t_tagsets
        t_tagsets(ws, 'edit', tagset='Parts', changes={'delete': True})


# --- applied ---------------------------------------------------------------------------

@pytest.fixture
def proj(live_client):
    s = seed(live_client, project_raw(), {'d1': document_raw()}, {VOCAB: lexicon_raw()},
             name='igt-agent tagset test')
    yield s
    s.delete()


def ws_of(s):
    return Workspace(s.client, load_project(s.client, s.project_id))


def run(s, ws):
    """The app's write with the user's session, then the approval, which reads it back."""
    write_settings(s.client, ws.project, ws.ops)
    return execute_plan(s.client, ws.ops, source='test', label='tagsets', project=ws.project)


def layer(s, layer_id):
    p = s.client.projects.get(s.project_id)
    return next(sl for tl in p['text_layers'] for tk in tl['token_layers'] for sl in tk['span_layers']
                if sl['id'] == s.ids[layer_id])


def igt_config(s):
    return s.client.projects.get(s.project_id)['config']['igt']


def test_check_names_what_a_closed_list_would_refuse(proj):
    out = call_tool(ws_of(proj), 'tagsets', {'action': 'check', 'tagset': 'Leipzig'})
    assert 'Morph Gloss: 2 values' in out
    assert 'Closed, core would refuse 1 stored values: "Ali" (1)' in out


def test_closing_a_list_the_data_breaks_is_refused_whole(proj):
    ws = ws_of(proj)
    out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'mode': 'closed'}})
    assert 'Core will refuse this approval' in out and 'Morph Gloss (1: "Ali")' in out
    assert 'Ask the user whether they mean mixed' in out
    with pytest.raises(PlaidAPIError) as e:
        run(proj, ws)
    assert 'not in the closed tagset: Ali' in refusal_words(e.value)
    assert igt_config(proj)['tagsets']['Leipzig']['mode'] == 'mixed'


def test_a_closed_list_is_declared_with_the_configuration(proj):
    ws = ws_of(proj)
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig',
                              'changes': {'mode': 'closed', 'add': ['Ali']}})
    run(proj, ws)
    assert igt_config(proj)['tagsets']['Leipzig']['mode'] == 'closed'
    rules = layer(proj, MGLOSS)['constraints']['igt']
    assert {'type': 'single-span'} in rules
    vs = next(r for r in rules if r['type'] == 'value-set')
    assert vs['values'] == ['PL', 'ERG', 'Ali'] and vs['delimiters'] == '.:' and vs['parts'] == 'all'
    # Opening it again takes the value set off.
    ws = ws_of(proj)
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'mode': 'mixed'}})
    run(proj, ws)
    assert [r['type'] for r in layer(proj, MGLOSS)['constraints']['igt']] == ['single-span']


def test_a_list_seeded_from_a_field_assigned_and_renamed(proj):
    ws = ws_of(proj)
    out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Words',
                                    'changes': {'add_used': 'all', 'from_fields': ['Gloss']}})
    assert '1 values in use added from Gloss' in out
    assert '1 of them are ordinary word glosses' in out
    call_tool(ws, 'tagsets', {'action': 'assign', 'field': 'Gloss', 'tagset': 'Words'})
    call_tool(ws, 'tagsets', {'action': 'assign', 'field': 'Date', 'tagset': 'Words'})
    run(proj, ws)
    assert [v['value'] for v in igt_config(proj)['tagsets']['Words']['values']] == ['Ali']
    assert layer(proj, GLOSS)['config']['igt']['tagset'] == 'Words'
    assert igt_config(proj)['documentMetadata'] == [{'name': 'Date', 'tagset': 'Words'}]
    # A rename carries every field that used the old name.
    ws = ws_of(proj)
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Words', 'changes': {'rename_to': 'Lexemes'}})
    run(proj, ws)
    cfg = igt_config(proj)
    assert 'Words' not in cfg['tagsets'] and 'Lexemes' in cfg['tagsets']
    assert layer(proj, GLOSS)['config']['igt']['tagset'] == 'Lexemes'
    assert cfg['documentMetadata'] == [{'name': 'Date', 'tagset': 'Lexemes'}]


def test_a_tagset_changed_since_the_plan_refuses_it(proj):
    ws = ws_of(proj)
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'add': ['NOM']}})
    tagsets = igt_config(proj)['tagsets']
    proj.client.projects.set_config(proj.project_id, 'igt', 'tagsets',
                                    {**tagsets, 'Leipzig': {**tagsets['Leipzig'], 'mode': 'suggest'}})
    with pytest.raises(PlanOutOfDate) as e:
        run(proj, ws)
    assert 'the tagset "Leipzig" changed since this plan was made' in str(e.value)


def test_a_lexicon_keeps_its_own_tagsets(proj):
    ws = ws_of(proj)
    out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Category', 'lexicon': 'Lexicon',
                                    'changes': {'mode': 'closed', 'add': ['n', 'v']}})
    assert 'Planned' in out
    call_tool(ws, 'tagsets', {'action': 'assign', 'field': 'gloss', 'tagset': 'Category', 'lexicon': 'Lexicon'})
    run(proj, ws)
    lex = proj.client.vocab_layers.get(proj.ids[VOCAB])['config']['igt']
    assert lex['tagsets']['Category']['mode'] == 'closed'
    assert lex['fields']['gloss'] == {'inline': True, 'tagset': 'Category'}
    assert 'Category' not in igt_config(proj)['tagsets']


def test_delimiters_given_as_a_list_are_the_characters():
    ws = Workspace(FakeClient(), load_project(FakeClient(), 'p1'))
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'T', 'changes': {'delimiters': ['.', '(', ')', '.']}})
    assert ws.ops[-1]['after']['delimiters'] == '.()'


def test_approval_reads_back_what_the_app_wrote_and_never_writes(proj):
    ws = ws_of(proj)
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'add': ['NOM']}})
    with pytest.raises(PlanError) as e:
        execute_plan(proj.client, ws.ops, source='test', label='tagsets', project=ws.project)
    assert 'Approve it from the app' in str(e.value) and e.value.applied == 0
    assert 'NOM' not in [v['value'] for v in igt_config(proj)['tagsets']['Leipzig']['values']]
    counts = run(proj, ws)
    assert counts['tagset changes'] == 1
    # Applied again (a lost answer, a retry): it still reads as planned.
    assert execute_plan(proj.client, ws.ops, source='test', label='tagsets', project=ws.project)['tagset changes'] == 1


def test_tagset_changes_are_a_plan_of_their_own():
    ws = Workspace(FakeClient(), load_project(FakeClient(), 'p1'))
    call_tool(ws, 'set_field', {'document': 'Text 1', 'refs': ['s1.w1'], 'field': 'Gloss', 'value': 'x'})
    out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'add': ['NOM']}})
    assert 'a plan of their own' in out and all(op['kind'] != 'set_tagset' for op in ws.ops)


def test_a_seed_without_delimiters_says_compound_values_are_listed_whole(monkeypatch):
    from plaid_agent.igt import tagsets as T
    ws = Workspace(FakeClient(), load_project(FakeClient(), 'p1'))
    monkeypatch.setattr(T, '_attested', lambda ws, f: [('DEM2.DIST', 3), ('PL', 1)])
    out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'New', 'changes': {'add_used': 'tags', 'from_fields': ['Gloss']}})
    assert 'values such as "DEM2.DIST" are listed whole' in out
    out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Other', 'changes': {'delimiters': '.', 'add_used': 'tags', 'from_fields': ['Gloss']}})
    assert 'listed whole' not in out
    assert [v['value'] for v in ws.ops[-1]['after']['values']] == ['DEM2', 'DIST', 'PL']


def test_a_value_read_back_is_the_value_planned(proj):
    """What approval reads back must be exactly what the plan holds, or a
    write that landed is reported as changed since."""
    ws = ws_of(proj)
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {
        'add': [{'value': 'NOM', 'description': None, 'color': 'red'}, {'value': 'ACC', 'description': 'accusative'}]}})
    assert ws.ops[-1]['after']['values'][-2:] == [{'value': 'NOM'}, {'value': 'ACC', 'description': 'accusative'}]
    assert run(proj, ws)['tagset changes'] == 1


def _user(admin, email):
    from live import _Session
    try:
        admin.users.create(email, 'pw-for-tests-1', False)
    except Exception:  # noqa: BLE001 - left by an earlier run
        pass
    from plaid_client import PlaidClient
    return PlaidClient.login(_Session.url, email, 'pw-for-tests-1')


def test_a_maintainer_who_is_no_admin_may_and_a_writer_may_not(proj):
    admin = proj.client
    _user(admin, 'tagset-maint@x.org')
    _user(admin, 'tagset-writer@x.org')
    admin.projects.add_maintainer(proj.project_id, 'tagset-maint@x.org')
    admin.projects.add_writer(proj.project_id, 'tagset-writer@x.org')
    for email, may in (('tagset-maint@x.org', True), ('tagset-writer@x.org', False)):
        c = _user(admin, email)
        ws = Workspace(c, load_project(c, proj.project_id))
        ws.requester_id = email
        out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'add': ['DAT']}})
        assert ('Only a maintainer' not in out) == may, (email, out)
        if may:
            write_settings(c, ws.project, ws.ops)
            assert execute_plan(c, ws.ops, source='test', label='t', project=ws.project)['tagset changes'] == 1


# --- what review found (2026-10-14) -----------------------------------------------------

def _fake_ws():
    return Workspace(FakeClient(), load_project(FakeClient(), 'p1'))


def test_an_edit_by_a_name_the_plan_renamed_points_to_the_new_name():
    ws = _fake_ws()
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'rename_to': 'Other'}})
    out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'add': ['X']}})
    assert 'This plan renames "Leipzig" to "Other": edit "Other"' in out
    [op] = [op for op in ws.ops if op['kind'] == 'set_tagset']
    assert (op['was'], op['name']) == ('Leipzig', 'Other')


def test_a_deleted_tagset_made_again_is_an_edit_of_the_stored_one():
    ws = _fake_ws()
    call_tool(ws, 'tagsets', {'action': 'assign', 'field': 'Morph Gloss', 'tagset': ''})
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'delete': True}})
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'add': ['X']}})
    [op] = [op for op in ws.ops if op['kind'] == 'set_tagset']
    assert op['before']['mode'] == 'mixed' and [v['value'] for v in op['after']['values']] == ['X']


def test_a_field_assigned_in_the_plan_follows_a_later_rename():
    ws = _fake_ws()
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'New', 'changes': {'add': ['X']}})
    call_tool(ws, 'tagsets', {'action': 'assign', 'field': 'Gloss', 'tagset': 'New'})
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'New', 'changes': {'rename_to': 'Newer'}})
    [assign] = [op for op in ws.ops if op['kind'] == 'assign_tagset']
    assert assign['after'] == 'Newer' and assign['label'] == 'Gloss: tagset "Newer"'


def test_a_rename_onto_a_stored_name_the_plan_frees_is_refused():
    ws = _fake_ws()
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'rename_to': 'B'}})
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'C', 'changes': {'add': ['X']}})
    out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'C', 'changes': {'rename_to': 'Leipzig'}})
    assert 'which this plan frees' in out


def test_assign_then_rename_applies_with_the_field_on_the_new_name(proj):
    ws = ws_of(proj)
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'New', 'changes': {'add': ['Ali'], 'mode': 'closed'}})
    call_tool(ws, 'tagsets', {'action': 'assign', 'field': 'Gloss', 'tagset': 'New'})
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'New', 'changes': {'rename_to': 'Newer'}})
    run(proj, ws)
    assert layer(proj, GLOSS)['config']['igt']['tagset'] == 'Newer'
    assert any(r['type'] == 'value-set' for r in layer(proj, GLOSS)['constraints']['igt'])


def test_extra_keys_and_duplicates_in_a_stored_list_read_back_as_planned(proj):
    tagsets = igt_config(proj)['tagsets']
    tagsets['Leipzig']['values'] = [{'value': 'PL', 'description': None, 'flex_id': 'a'},
                                    {'value': 'PL ', 'flex_id': 'dup'}, {'value': 'ERG'}]
    proj.client.projects.set_config(proj.project_id, 'igt', 'tagsets', tagsets)
    ws = ws_of(proj)
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'add': ['NOM']}})
    assert run(proj, ws)['tagset changes'] == 1
