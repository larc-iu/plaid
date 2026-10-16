"""The tagsets tool says of a closed list exactly what core will do
(H16-IGT-TOOLS-3, then the refused-values route, ruled 2026-10-15): core
lets an unconfirmed machine value stay, and a value an import, a document
copy or a restore set (plaid-core sql/constraints/layer.clj
`check-value-set`), and the tool asks core which values it would refuse, so
it names those and counts the rest apart. Against a live core."""

import pytest
from fixtures import project_raw, document_raw, lexicon_raw, VOCAB, MGLOSS
from live import live_client, seed  # noqa: F401 - fixture

from plaid_agent.igt.tagsets import refusal_words
from plaid_agent.igt.toolkit import call_tool
from plaid_client import PlaidAPIError
from test_tagset_tools import igt_config, layer, run, ws_of


@pytest.fixture
def proj(live_client):
    s = seed(live_client, project_raw(), {'d1': document_raw()}, {VOCAB: lexicon_raw()},
             name='igt-agent tagset exemption test')
    # "Ali" is a person's (the seed's plain batch). XIMP comes in through an
    # import, XMACH from a machine nobody confirmed.
    with s.client.operation('Import a text', kind='import'):
        s.client.spans.create(s.ids[MGLOSS], [s.ids['m-2']], 'XIMP')
    s.client.spans.create(s.ids[MGLOSS], [s.ids['m-4a']], 'XMACH',
                          metadata={'prov': 'inferred', 'provSource': 'service:x'})
    yield s
    s.delete()


def test_check_names_what_core_would_refuse_and_counts_what_it_lets_stay(proj):
    out = call_tool(ws_of(proj), 'tagsets', {'action': 'check', 'tagset': 'Leipzig'})
    assert ('  Closed, core would refuse 1 stored value: "Ali" (1). Besides, 2 stored values off the list that '
            'core lets stay (unconfirmed machine values, or set by an import, a document copy or a restore).'
            in out.splitlines()), out


def test_check_says_core_would_refuse_none_when_only_exempt_values_are_off(proj):
    # The edit is only planned: check reads the plan, and core is asked about the planned list.
    ws = ws_of(proj)
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'add': ['Ali']}})
    out = call_tool(ws, 'tagsets', {'action': 'check', 'tagset': 'Leipzig'})
    assert '  Closed, core would refuse none. Besides, 2 stored values off the list' in out, out


def test_a_close_core_takes_is_not_called_refused(proj):
    ws = ws_of(proj)
    out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig',
                                    'changes': {'mode': 'closed', 'add': ['Ali']}})
    assert 'Core will refuse' not in out, out
    run(proj, ws)
    assert igt_config(proj)['tagsets']['Leipzig']['mode'] == 'closed'
    # In force now: what is off the list is what core let stay.
    out = call_tool(ws_of(proj), 'tagsets', {'action': 'check', 'tagset': 'Leipzig'})
    assert ('Off the closed list, kept as core lets them stay: 2 stored values: "XIMP" (1), "XMACH" (1)'
            in out), out
    assert 'cannot tell apart' not in out, out


def test_a_close_a_persons_value_breaks_is_still_refused_by_core(proj):
    ws = ws_of(proj)
    out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'mode': 'closed'}})
    assert 'Core will refuse this approval' in out and 'Morph Gloss (1 stored value: "Ali" (1))' in out, out
    with pytest.raises(PlaidAPIError) as e:
        run(proj, ws)
    words = refusal_words(e.value)
    assert 'Ali' in words and 'XIMP' not in words and 'XMACH' not in words, words


def test_a_field_whose_layer_lost_its_list_is_read_from_core_and_holds_up_no_other_change(proj):
    """REV-WIRE-1: Leipzig is closed in the settings, but the Morph Gloss layer
    holds no list (another client removed its rules) and a person wrote QQ.
    check says core does not hold the list instead of calling QQ a value core
    let stay, and a change to another tagset neither warns about Morph Gloss
    nor declares on it, so approval goes through."""
    ws = ws_of(proj)
    call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig', 'changes': {'mode': 'closed', 'add': ['Ali']}})
    run(proj, ws)
    proj.client.span_layers.delete_constraints(proj.ids[MGLOSS], 'igt')
    proj.client.spans.create(proj.ids[MGLOSS], [proj.ids['m-4b']], 'QQ')

    out = call_tool(ws_of(proj), 'tagsets', {'action': 'check', 'tagset': 'Leipzig'})
    assert 'kept as core lets them stay' not in out, out
    assert 'core does not hold the list on Morph Gloss' in out, out
    assert '  Closed, core would refuse 1 stored value: "QQ" (1).' in out, out

    ws = ws_of(proj)
    out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'POS',
                                    'changes': {'mode': 'closed', 'add': ['N', 'V']}})
    assert 'Core will refuse' not in out, out
    run(proj, ws)
    assert igt_config(proj)['tagsets']['POS']['mode'] == 'closed'
    assert not (layer(proj, MGLOSS).get('constraints') or {}).get('igt')
