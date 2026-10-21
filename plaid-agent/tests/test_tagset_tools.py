"""The tagsets tool, staged and then applied against a real server.

Setting up a tagset is rare, so the tool is one short schema whose ``help``
action carries the instructions. What approval writes is checked on a real core,
because a closed list is a rule core holds: the declaration goes in the batch
that writes the configuration, and stored values that break it refuse that batch.
"""

import pytest
from fixtures import project_raw, document_raw, lexicon_raw, VOCAB, MGLOSS, GLOSS, FakeClient
from live import live_client, seed  # noqa: F401 - fixture
from page_write import PageRefused, page_write

from plaid_agent.core.plan import PlanError, PlanOutOfDate
from plaid_agent.core.tools import ToolError
from plaid_agent.igt import toolkit
from plaid_agent.igt.plan import execute_plan
from plaid_agent.igt.project import load_project
from plaid_agent.igt.tagsets import HELP
from plaid_client.workflows.igt.tagsets import field_constraints
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

def declare_igt_rules(s):
    """Every igt field's rules as its settings want them, as igt's setup
    declares them on a new project (the seed declares none)."""
    p = s.client.projects.get(s.project_id)
    for tl in p['text_layers']:
        for tk in tl['token_layers']:
            for sl in tk.get('span_layers') or []:
                if ((sl.get('config') or {}).get('igt') or {}).get('scope'):
                    s.client.span_layers.set_constraints(sl['id'], 'igt',
                                                         field_constraints(sl.get('config'), p.get('config')))


@pytest.fixture
def proj(live_client):
    s = seed(live_client, project_raw(), {'d1': document_raw()}, {VOCAB: lexicon_raw()},
             name='igt-agent tagset test')
    declare_igt_rules(s)
    yield s
    s.delete()


def ws_of(s):
    return Workspace(s.client, load_project(s.client, s.project_id))


def run(s, ws):
    """The app's write with the user's session, then the approval, which reads it back."""
    page_write(s.client, s.project_id, ws.ops)
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
    assert '  Closed, core would refuse 1 stored value: "Ali" (1).' in out.splitlines(), out


def test_closing_a_list_the_data_breaks_is_refused_whole(proj):
    ws = ws_of(proj)
    out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'mode': 'closed'}})
    assert ('Core will refuse this approval, writing nothing, while these stored values break the closed list: '
            'Morph Gloss (1 stored value: "Ali" (1)).') in out, out
    assert 'Ask the user whether they mean mixed' in out
    with pytest.raises(PageRefused) as e:
        run(proj, ws)
    assert '1 value in Morph Gloss is not in the tagset: Ali.' in str(e.value)
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
    with pytest.raises(PageRefused) as e:
        run(proj, ws)
    assert 'The tagset settings this plan changes were changed since it was made' in str(e.value)
    with pytest.raises(PlanOutOfDate) as e:
        execute_plan(proj.client, ws.ops, source='test', label='tagsets', project=ws.project)
    assert 'changed some other way' in str(e.value)


def test_a_lexicon_keeps_its_own_tagsets(proj):
    ws = ws_of(proj)
    out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Category', 'lexicon': 'Lexicon',
                                    'changes': {'mode': 'closed', 'add': ['n', 'v']}})
    assert 'Planned' in out
    call_tool(ws, 'tagsets', {'action': 'assign', 'field': 'gloss', 'tagset': 'Category', 'lexicon': 'Lexicon'})
    run(proj, ws)
    lex = proj.client.vocab_layers.get(proj.ids[VOCAB])['config']['igt']
    assert lex['tagsets']['Category']['mode'] == 'closed'
    assert lex['fields']['gloss'] == {'inline': True, 'tagset': 'Category', 'role': 'gloss'}
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
            page_write(c, proj.project_id, ws.ops)
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


def test_help_and_check_are_reads_so_a_repeat_gets_its_answer():
    """The agent loop answers a repeated PLAN call with "already planned",
    and labels one that planned nothing "Nothing to change". Neither is
    true of the manual or a check."""
    from plaid_agent.core.trace import META, PLAN, READ, trace_step
    from plaid_agent.igt.trace import TRACER
    assert TRACER.call_kind('tagsets', {'action': 'help'}) == META
    assert TRACER.call_kind('tagsets', {'action': 'check', 'tagset': 'L'}) == READ
    assert TRACER.call_kind('tagsets', {'action': 'edit', 'tagset': 'L'}) == PLAN
    item = trace_step(TRACER, 'c1', 'tagsets', {'action': 'help'})
    assert item['label'] == 'Read how to set up tagsets' and item['kind'] == META


@pytest.mark.parametrize('action, kind', [('Help', 'META'), (' help', 'META'), ('CHECK', 'READ'), (' Check ', 'READ'),
                                          ('Edit', 'PLAN')])
def test_the_trace_reads_the_action_as_the_tool_does(action, kind):
    """H16-REVIEW-6: an action in another case or with a space is the read it
    answers, so a repeat gets its answer and the step is no "Nothing to change"."""
    from plaid_agent.core import trace
    from plaid_agent.igt.trace import TRACER
    assert TRACER.call_kind('tagsets', {'action': action, 'tagset': 'L'}) == getattr(trace, kind)
    label = TRACER.describe('tagsets', {'action': action, 'tagset': 'L'})
    assert label == {'META': 'Read how to set up tagsets', 'READ': 'Checked the tagset “L”',
                     'PLAN': 'Planned a change to the tagset “L”'}[kind]


def test_check_sets_numerals_and_bracketed_parts_apart_from_tags(monkeypatch):
    """igt-tagset-close-hard r3 (build-q38-1) read "Tags: YON) (14), HITHER)
    (2), 03 (1), 1941 (1)" from values like bz(PDIR.YON).o(1MINI) and years
    glossed as themselves, and spent four searches on "YON)". They are parts
    as core reads them (it splits on the delimiters only, so a close needs
    them listed), but no tags: said apart, with what splits a bracket."""
    from plaid_agent.igt import tagsets as T
    ws = _fake_ws()
    monkeypatch.setattr(T, '_attested', lambda ws, f: [('bz(PDIR.YON).o(1MINI)', 14), ('1941', 1), ('03', 1),
                                                       ('3AUG', 2), ('go', 5)])
    monkeypatch.setattr(T, '_core_refused', lambda ws, f, t, limit=T.SHOWN: {'count': 0, 'value_count': 0,
                                                                            'values': []})
    out = call_tool(ws, 'tagsets', {'action': 'check', 'tagset': 'Leipzig', 'field': 'Morph Gloss'})
    lines = out.splitlines()
    tags = next(line for line in lines if line.startswith('  Tags: '))
    assert 'YON)' not in tags and '1941' not in tags and '3AUG (2)' in tags, out
    assert ('  Parts holding a bracket, which the delimiters do not split (add "()" to the delimiters to split '
            'them): YON) (14)') in lines, out
    assert '  Parts without a letter: 03 (1), 1941 (1)' in lines, out
    # add_used still lists the parts core reads, so a close after it holds.
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'add_used': 'tags',
                                                                                  'from_fields': ['Morph Gloss']}})
    assert {'YON)', '1941', '3AUG'} <= {v['value'] for v in ws.ops[-1]['after']['values']}


def test_a_refused_value_names_the_parts_off_the_list():
    """REV-WIRE-3: of a composite value, the parts core names are shown."""
    from plaid_agent.igt.tagsets import _refused_line
    r = {'count': 3, 'value_count': 2, 'values': [{'value': '1SG.NOM', 'parts': ['1SG'], 'count': 2},
                                                  {'value': 'QQ', 'parts': ['QQ'], 'count': 1}]}
    assert _refused_line(r) == '3 stored values, 2 distinct: "1SG.NOM" (2, "1SG" not listed), "QQ" (1)'


def test_an_empty_part_is_named_as_igt_names_it(monkeypatch):
    """REV2-WIRE-3: a delimiter with nothing on one side ("V..N") is "an empty
    part", as igt's notice says, in core's answer and in the check's summary."""
    from plaid_agent.igt import tagsets as T
    r = {'count': 2, 'value_count': 2, 'values': [{'value': 'V..N', 'parts': ['V', '', 'N'], 'count': 1},
                                                  {'value': 'N.X', 'parts': ['X'], 'count': 1}]}
    assert T._refused_line(r) == ('2 stored values: "V..N" (1, "V", an empty part, "N" not listed), '
                                  '"N.X" (1, "X" not listed)')
    ws = _fake_ws()
    monkeypatch.setattr(T, '_attested', lambda ws, f: [('PL..ERG', 3), ('PL', 2)])
    monkeypatch.setattr(T, '_core_refused', lambda ws, f, t, limit=T.SHOWN: {'count': 0, 'value_count': 0,
                                                                            'values': []})
    out = call_tool(ws, 'tagsets', {'action': 'check', 'tagset': 'Leipzig', 'field': 'Morph Gloss'})
    lines = out.splitlines()
    assert 'Morph Gloss: 5 values, 1 distinct value with an empty part.' in lines, out
    assert '  An empty part, which a closed list refuses: "PL..ERG" (3)' in lines, out
