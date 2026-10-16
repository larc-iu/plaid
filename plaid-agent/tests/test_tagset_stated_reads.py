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
