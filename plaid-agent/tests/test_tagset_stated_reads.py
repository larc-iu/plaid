"""Luke's rulings on REV6-WIRE (2026-10-16), for ``write_settings`` (the
app's write in Python, igt's ``writeTagsetPlan``): a plan write states the
tagsets it read and is refused when they changed before it landed; a plan
pointing a field at a tagset renamed or deleted since it was made is refused;
a field naming a tagset the project does not have has its list taken off by
the heal. Against a live core."""

import pytest
from fixtures import project_raw, document_raw, lexicon_raw, VOCAB, MGLOSS, TRANS
from live import live_client, seed  # noqa: F401 - fixture

from plaid_agent.core.plan import PlanOutOfDate
from plaid_agent.igt import tagsets as T
from plaid_agent.igt.toolkit import call_tool
from test_tagset_tools import declare_igt_rules, igt_config, layer, run, ws_of


@pytest.fixture
def proj(live_client):
    s = seed(live_client, project_raw(), {'d1': document_raw()}, {VOCAB: lexicon_raw()},
             name='igt-agent tagset stated reads test')
    declare_igt_rules(s)
    yield s
    s.delete()


def rules(s, lid):
    return (layer(s, lid).get('constraints') or {}).get('igt')


def _close_leipzig(s):
    ws = ws_of(s)
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'mode': 'closed', 'add': ['Ali']}})
    run(s, ws)


def _rename_leipzig(s, to='L2'):
    """Another maintainer's rename, as the app's Tagsets screen writes it."""
    ws = ws_of(s)
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'rename_to': to}})
    run(s, ws)


def test_a_plan_assigning_a_tagset_renamed_since_is_refused(proj):
    ws = ws_of(proj)
    out = call_tool(ws, 'tagsets', {'action': 'assign', 'field': 'Translation', 'tagset': 'Leipzig'})
    assert 'Core will refuse' not in out, out
    _rename_leipzig(proj)
    with pytest.raises(PlanOutOfDate) as e:
        T.write_settings(proj.client, ws.project, ws.ops)
    assert 'the tagset "Leipzig" this plan assigns no longer exists' in str(e.value.reasons), e.value.reasons
    assert 'tagset' not in (layer(proj, TRANS)['config'].get('igt') or {})


def test_a_plan_write_states_the_tagsets_it_read(proj, monkeypatch):
    """The tagsets change between the write's read and its batch: the batch
    is refused whole with the ruled words, and nothing it queued is written."""
    ws = ws_of(proj)
    call_tool(ws, 'tagsets', {'action': 'assign', 'field': 'Translation', 'tagset': 'Leipzig'})
    queue = T.queue_settings

    def racing(client, b, project, ops):
        changed = queue(client, b, project, ops)
        cfg = igt_config(proj)
        cur = cfg['tagsets']
        nxt = {**cur, 'Leipzig': {**cur['Leipzig'], 'values': cur['Leipzig']['values'] + [{'value': 'V'}]}}
        client.projects.set_config(proj.project_id, 'igt', 'tagsets', nxt, expected=cur)
        return changed

    monkeypatch.setattr(T, 'queue_settings', racing)
    with pytest.raises(PlanOutOfDate) as e:
        T.write_settings(proj.client, ws.project, ws.ops)
    assert e.value.reasons == [T.TAGSETS_CHANGED]
    assert 'tagset' not in (layer(proj, TRANS)['config'].get('igt') or {})


def test_a_list_on_a_field_naming_a_missing_tagset_is_taken_off_by_the_heal(proj):
    _close_leipzig(proj)
    assert any(r['type'] == 'value-set' for r in rules(proj, MGLOSS))
    # A script points Morph Gloss at a name the project does not have.
    proj.client.span_layers.set_config(proj.ids[MGLOSS], 'igt', 'tagset', 'Gone')
    T.heal_fields(proj.client, proj.project_id, {proj.ids[MGLOSS]})
    assert rules(proj, MGLOSS) == [{'type': 'single-span'}]


def test_a_plan_changing_the_project_and_a_lexicon_writes_each_owner_its_own(proj):
    """REV7-WIRE-2: each owner's tagsets write goes to that owner, not to the
    owner the loop ended on."""
    ws = ws_of(proj)
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'NewA',
                              'changes': {'add': ['a', 'b'], 'mode': 'closed', 'delimiters': ''}})
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'LX', 'lexicon': 'Lexicon',
                              'changes': {'mode': 'closed', 'add': ['n', 'v']}})
    T.write_settings(proj.client, ws.project, ws.ops)
    assert 'NewA' in igt_config(proj)['tagsets']
    lex = proj.client.vocab_layers.get(proj.ids[VOCAB])['config']['igt']['tagsets']
    assert 'LX' in lex and 'NewA' not in lex


def test_an_assign_another_maintainer_already_made_writes_nothing_and_passes(proj):
    """REV7-WIRE-2: settings already as the plan leaves them read as done, as
    igt's ``writeTagsetPlan`` reads them."""
    ws = ws_of(proj)
    call_tool(ws, 'tagsets', {'action': 'assign', 'field': 'Translation', 'tagset': 'Leipzig'})
    proj.client.span_layers.set_config(proj.ids[TRANS], 'igt', 'tagset', 'Leipzig')
    assert T.check_settings(proj.client, ws.project, ws.ops) == []
    assert T.write_settings(proj.client, ws.project, ws.ops) == []
    assert layer(proj, TRANS)['config']['igt']['tagset'] == 'Leipzig'


def test_a_stated_read_of_a_stored_null_writes_nothing(proj):
    """REV7-WIRE-7: a cell holding JSON null, stated as read, stays as it is."""
    proj.client.span_layers.set_config(proj.ids[TRANS], 'igt', 'tagset', None)
    q = T._Queue()
    T._queue_stated(q, 'span_layers', proj.ids[TRANS], 'tagset', None)
    with proj.client.batched() as batch:
        for fn in q.calls:
            fn(batch)
    igt = layer(proj, TRANS)['config']['igt']
    assert 'tagset' in igt and igt['tagset'] is None


@pytest.mark.parametrize('stored', [None, '', '  ', ' Leipzig '])
def test_a_project_plan_leaves_document_metadata_it_does_not_change_as_stored(proj, monkeypatch, stored):
    """REV8-AGENT R8A-2: igt's metadata screen stores "No tagset" as null, and
    another writer may leave "" or a padded name. A plan that does not change
    such a field's tagset leaves the list as stored, as igt's queueOwner
    does, so a metadata field added by another maintainer between the read
    and the batch does not refuse it."""
    c, pid = proj.client, proj.project_id
    meta = [{'name': 'Date', 'tagset': stored}]
    c.projects.set_config(pid, 'igt', 'documentMetadata', meta)
    ws = ws_of(proj)
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'add': ['NOM2']}})
    queue = T.queue_settings
    raced = meta + [{'name': 'Place', 'tagset': None}]

    def racing(client, b, project, ops):
        changed = queue(client, b, project, ops)
        c.projects.set_config(pid, 'igt', 'documentMetadata', raced)
        return changed

    monkeypatch.setattr(T, 'queue_settings', racing)
    T.write_settings(c, ws.project, ws.ops)
    igt = igt_config(proj)
    assert igt['documentMetadata'] == raced
    assert 'NOM2' in [v['value'] for v in igt['tagsets']['Leipzig']['values']]
