"""The tagsets tool says of a closed list only what core will do
(H16-IGT-TOOLS-3): core lets an unconfirmed machine value stay, and a value
an import, a document copy or a restore set (plaid-core
sql/constraints/layer.clj `check-value-set`). The machine values are told
exactly, from their metadata. Which of the others an import set only the
audit log knows, so the tool never predicts a refusal, and core is asked by
the approval. Against a live core."""

import pytest
from fixtures import project_raw, document_raw, lexicon_raw, VOCAB, MGLOSS
from live import live_client, seed  # noqa: F401 - fixture

from plaid_agent.igt.tagsets import refusal_words
from plaid_agent.igt.toolkit import call_tool
from plaid_client import PlaidAPIError
from test_tagset_tools import igt_config, run, ws_of


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


def test_check_counts_machine_values_apart_and_predicts_no_refusal(proj):
    out = call_tool(ws_of(proj), 'tagsets', {'action': 'check', 'tagset': 'Leipzig'})
    assert 'core would refuse' not in out, out
    assert ('Off the list if closed: 2 stored values: "Ali" (1), "XIMP" (1). '
            'Besides, 1 unconfirmed machine value, which core lets stay.') in out, out
    assert 'an import, a document copy or a restore' in out, out


def test_a_close_core_takes_is_not_called_refused(proj):
    ws = ws_of(proj)
    out = call_tool(ws, 'tagsets', {'action': 'edit', 'tagset': 'Leipzig',
                                    'changes': {'mode': 'closed', 'add': ['Ali']}})
    assert 'Core will refuse' not in out, out
    assert 'Morph Gloss (1: "XIMP")' in out, out
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
    assert 'Morph Gloss (2: "Ali", "XIMP")' in out, out
    with pytest.raises(PlaidAPIError) as e:
        run(proj, ws)
    words = refusal_words(e.value)
    assert 'Ali' in words and 'XIMP' not in words and 'XMACH' not in words, words
