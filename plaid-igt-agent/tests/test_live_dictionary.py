"""The dictionary tools against a real server, applied for real.

The fake client checks what the tools PLAN. This checks what the server ends up
holding, because that is the actual contract: the sense tree, the entry
references and the promoted examples are read back by plaid-igt's own domain
code, and its load-time validator throws away anything shaped wrong.
"""
import pytest
from fixtures import project_raw, document_raw, lexicon_raw, VOCAB
from live import live_client, seed  # noqa: F401 - fixture

from plaid_igt_agent.project import load_project
from plaid_igt_agent.tools import Workspace, call_tool
from plaid_igt_agent.plan import execute_plan

FIELDS = {
    'gloss': {'inline': True},
    'variantOf': {'inline': False, 'type': 'item'},
    'seeAlso': {'inline': False, 'type': 'item', 'many': True},
    'etymology': {'inline': False, 'scope': 'entry'},
}


@pytest.fixture(scope='module')
def lex(live_client):
    """A real IGT project carrying a second vocabulary with senses:
    kwatha with two senses (one of them with a subsense), and two entries that
    refer to it."""
    s = seed(live_client, project_raw(), {'d1': document_raw()}, {VOCAB: lexicon_raw()},
             name='igt-agent dictionary test')
    c = s.client
    v = c.vocab_layers.create('LiveLex')
    c.projects.link_vocab(s.project_id, v['id'])
    c.vocab_layers.set_config(v['id'], 'igt', 'fields', FIELDS)

    def mk(form, meta):
        return c.vocab_items.create(v['id'], form, meta)['id']
    ids = {}
    ids['kwatha'] = mk('kwatha', {'gloss': 'cook', 'etymology': 'Proto-Bantu'})
    ids['boil'] = mk('kwatha', {'gloss': 'boil', 'parent': ids['kwatha'], 'senseOrder': 1})
    ids['simmer'] = mk('kwatha', {'gloss': 'simmer', 'parent': ids['boil'], 'senseOrder': 1})
    ids['ferment'] = mk('kwatha', {'gloss': 'ferment', 'parent': ids['kwatha'], 'senseOrder': 2})
    ids['phika'] = mk('phika', {'gloss': 'cook', 'variantOf': ids['kwatha']})
    ids['nyumba'] = mk('nyumba', {'gloss': 'house', 'seeAlso': [ids['kwatha'], ids['phika']]})
    s.vocab_ids.append(v['id'])
    s.lex_id, s.item_ids = v['id'], ids
    yield s
    s.delete()


def items_of(lex):
    return {it['id']: it for it in lex.client.vocab_layers.get(lex.lex_id, include_items=True)['items']}


def ws_of(lex):
    return Workspace(lex.client, load_project(lex.client, lex.project_id))


def run(lex, w):
    execute_plan(lex.client, w.ops, source='test', label='dictionary tools', project=w.project)


def test_the_tree_reads_back_as_the_app_stores_it(lex):
    out = call_tool(ws_of(lex), 'read_lexicon', {'lexicon': 'LiveLex'})
    assert '3 headwords, 3 senses' in out
    assert '1.1 kwatha | sense 1.1 of "kwatha" | gloss=boil | 1 sense below' in out
    assert '1.1.1 kwatha | sense 1.1.1 of "kwatha" | gloss=simmer' in out
    # Ids never reach the model as though they were field values.
    assert lex.item_ids['kwatha'] not in out
    assert 'variantOf="kwatha"' in out and 'seeAlso="kwatha", "phika"' in out


def test_writes_land_in_the_shape_the_app_reads(lex):
    ids = lex.item_ids
    w = ws_of(lex)
    # A reference given as a form, a sense renumbered, a sense added, an example.
    call_tool(w, 'set_entry_field', {'entry_form': 'nyumba', 'field': 'variantOf', 'value': 'kwatha#1.2'})
    call_tool(w, 'move_sense', {'entry_form': 'kwatha#1.2', 'number': '1'})
    call_tool(w, 'add_sense', {'entry_form': 'kwatha', 'fields': {'gloss': 'stew'}})
    call_tool(w, 'promote_example', {'entry_form': 'phika', 'document': 'Text 1', 'ref': 's1.w2'})
    run(lex, w)

    got = items_of(lex)
    # One reference is one id, never a list and never the form the model typed.
    assert got[ids['nyumba']]['metadata']['variantOf'] == ids['ferment']
    # Renumbering keeps the sibling orders dense, so a later move is a swap.
    assert got[ids['ferment']]['metadata']['senseOrder'] == 1
    assert got[ids['boil']]['metadata']['senseOrder'] == 2
    stew = next(it for it in got.values() if it['metadata'].get('gloss') == 'stew')
    assert stew['metadata']['parent'] == ids['kwatha'] and stew['metadata']['senseOrder'] == 3
    ex = got[ids['phika']]['metadata']['examples']
    assert len(ex) == 1 and set(ex[0]) == {'document', 'token'}
    lex.item_ids['stew'] = stew['id']


def test_deleting_an_entry_carries_its_senses_and_references(lex):
    """Runs after the writes above, on the tree they left."""
    ids = lex.item_ids
    w = ws_of(lex)
    out = call_tool(w, 'delete_entry', {'entry_form': 'kwatha'})
    assert 'freed or cleared' in out
    run(lex, w)

    got = items_of(lex)
    assert ids['kwatha'] not in got
    # Its senses become entries; a subsense keeps the sense it hung from.
    for name in ('boil', 'ferment', 'stew'):
        assert 'parent' not in got[ids[name]]['metadata'], name
    assert got[ids['simmer']]['metadata']['parent'] == ids['boil']
    # A field naming the deleted entry lets go; one naming a freed sense stands.
    assert 'variantOf' not in got[ids['phika']]['metadata']
    assert got[ids['nyumba']]['metadata']['seeAlso'] == [ids['phika']]
    assert got[ids['nyumba']]['metadata']['variantOf'] == ids['ferment']
