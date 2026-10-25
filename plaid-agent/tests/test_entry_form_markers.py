"""R27: an entry's form is stored without affix or clitic markers. The
assistant's entry writers pass the form and type they were given through the
client's one rule (plaid_client.workflows.igt.entry_forms.entry_form)."""

from fixtures import FakeClient, fake_ws

from plaid_agent.igt.toolkit import call_tool


def _ws():
    return fake_ws(FakeClient())


def _op(ws, kind):
    return [op for op in ws.ops if op['kind'] == kind]


def test_a_new_entry_typed_with_markers_is_stored_bare_with_their_type():
    ws = _ws()
    assert 'Planned' in call_tool(ws, 'create_entry', {'form': '-s', 'fields': {'gloss': 'PL'}})
    [op] = _op(ws, 'create_entry')
    assert op['form'] == 's' and op['metadata']['morphType'] == 'suffix'
    ws = _ws()
    call_tool(ws, 'create_entry', {'form': 'ka-', 'type': 'prefix'})
    [op] = _op(ws, 'create_entry')
    assert op['form'] == 'ka' and op['metadata']['morphType'] == 'prefix'
    # A type given is kept, the markers only dropped (R38).
    ws = _ws()
    call_tool(ws, 'create_entry', {'form': '=ri', 'type': 'stem'})
    [op] = _op(ws, 'create_entry')
    assert op['form'] == 'ri' and op['metadata']['morphType'] == 'stem'
    ws = _ws()
    call_tool(ws, 'create_entry', {'form': 'theŋjən-', 'type': 'bound stem'})
    [op] = _op(ws, 'create_entry')
    assert op['form'] == 'theŋjən' and op['metadata']['morphType'] == 'bound stem'
    # A form with no marker keeps its type.
    ws = _ws()
    call_tool(ws, 'create_entry', {'form': 'kai', 'type': 'stem'})
    [op] = _op(ws, 'create_entry')
    assert op['form'] == 'kai' and op['metadata']['morphType'] == 'stem'


def test_a_new_sense_with_a_marked_form_is_stored_bare():
    ws = _ws()
    call_tool(ws, 'senses', {'action': 'add', 'entry_id': 'vi-gam', 'form': '-gam'})
    [op] = _op(ws, 'create_entry')
    assert op['form'] == 'gam' and op['metadata']['morphType'] == 'suffix'


def test_a_rename_to_a_marked_form_stores_it_bare_and_takes_the_type_the_markers_name():
    ws = _ws()
    # vi-erg is a suffix: its markers are dropped and its type stays.
    call_tool(ws, 'rename_entry', {'entry_id': 'vi-erg', 'new_form': '-du'})
    [op] = _op(ws, 'rename_entry')
    assert op['form'] == 'du' and 'morph_type' not in op
    ws = _ws()
    call_tool(ws, 'rename_entry', {'entry_id': 'vi-ali', 'new_form': 'ka-'})
    [op] = _op(ws, 'rename_entry')
    assert op['form'] == 'ka' and op['morph_type'] == 'prefix'


def test_a_rename_that_takes_a_type_writes_it_with_the_form():
    from plaid_agent.igt.plan import execute_plan
    ws = _ws()
    call_tool(ws, 'rename_entry', {'entry_id': 'vi-ali', 'new_form': 'ka-'})
    execute_plan(ws.client, ws.plan_payload()['ops'], source='s', label='l', project=ws.project)
    assert ('vi-ali', 'ka') in ws.client.updates('vocab_items')
    assert ('vi-ali', [{'op': 'set', 'path': ['morphType'], 'value': 'prefix'}]) in ws.client.patches('vocab_items')


def test_a_respelling_carried_into_the_headwords_stores_them_as_bulk_edit_does():
    # REV-R4-IGT D4: Bulk Edit's lexicon rows go through entryForm with the
    # entry's own type (bulkPlan.js collectLexiconRows), and so does respell_all.
    from fixtures import applied
    ws = _ws()
    out = call_tool(ws, 'respell_all', {'lexicon': True, 'pattern': 'di', 'replacement': 'du',
                                        'morpheme_forms': False})
    assert not out.startswith('Error'), out
    c = applied(ws)
    # vi-erg is the suffix "-di": "-du" is stored "du", the type unchanged.
    assert c.updates('vocab_items') == [('vi-erg', 'du')] and c.patches('vocab_items') == []
    ws = _ws()
    call_tool(ws, 'respell_all', {'lexicon': True, 'pattern': 'Ali', 'replacement': 'ka-', 'whole': True,
                                  'morpheme_forms': False})
    c = applied(ws)
    # An untyped entry takes the type its new markers name.
    assert c.updates('vocab_items') == [('vi-ali', 'ka')]
    assert c.patches('vocab_items') == [('vi-ali', [{'op': 'set', 'path': ['morphType'], 'value': 'prefix'}])]
