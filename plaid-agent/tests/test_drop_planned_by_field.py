"""drop_planned takes a field, a document or both, besides plan_status
numbers, so a model taking one field's changes out of a large plan does not
count them out by hand."""
from fixtures import fake_ws

from plaid_agent.igt.toolkit import TOOLS, call_tool
from test_tools import _two_documents


def _planned():
    w = fake_ws(_two_documents('Text 2'))
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2', 's1.w3'], 'field': 'Gloss', 'value': 'x'})
    call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1'], 'field': 'Translation', 'value': 'y'})
    call_tool(w, 'set_entry_field', {'entry_id': 'vi-ali', 'field': 'pos', 'value': 'PN'})
    w.ops.append({'kind': 'set_span', 'layer_id': 'sl-gloss', 'token_id': 'w-9', 'value': 'z', 'doc': 'd2',
                  'label': 'Text 2 s1.w9: Gloss = "z"'})
    assert [o.get('layer_id') or o.get('field') for o in w.ops] == ['sl-gloss', 'sl-gloss', 'sl-trans', 'pos',
                                                                    'sl-gloss']
    return w


def test_a_field_drops_every_change_that_writes_it():
    w = _planned()
    out = call_tool(w, 'drop_planned', {'field': 'gloss'})
    assert out.startswith('Dropped 3 planned changes.')
    assert [o.get('layer_id') or o.get('field') for o in w.ops] == ['sl-trans', 'pos']
    assert call_tool(w, 'drop_planned', {'field': 'pos'}).startswith('Dropped 1 planned change.')


def test_a_document_drops_the_changes_in_it_and_both_narrow_each_other():
    w = _planned()
    out = call_tool(w, 'drop_planned', {'document': 'Text 1', 'field': 'Gloss'})
    assert out.startswith('Dropped 2 planned changes.')
    assert [o.get('layer_id') or o.get('field') for o in w.ops] == ['sl-trans', 'pos', 'sl-gloss']
    assert call_tool(w, 'drop_planned', {'document': 'Text 2'}).startswith('Dropped 1 planned change.')
    assert [o.get('layer_id') or o.get('field') for o in w.ops] == ['sl-trans', 'pos']


def test_a_change_reaching_other_documents_too_is_kept_and_said():
    w = _planned()
    w.ops.append({'kind': 'bulk_scope', 'tool': 'replace_in_field', 'args': {'field': 'Gloss'},
                  'documents': ['d1', 'd2'], 'label': 'Gloss x → y everywhere'})
    out = call_tool(w, 'drop_planned', {'document': 'd2'})
    assert out.startswith('Dropped 1 planned change. 1 change that also reaches other documents was kept')
    assert w.ops[-1]['kind'] == 'bulk_scope'
    assert call_tool(w, 'drop_planned', {'field': 'Gloss'}).startswith('Dropped 3 planned changes.')


def test_nothing_matching_is_refused_with_the_fields_the_plan_writes():
    w = _planned()
    out = call_tool(w, 'drop_planned', {'field': 'Morph Gloss'})
    assert out == 'Error: No planned change writes Morph Gloss. The plan writes Gloss, pos, Translation. See plan_status.'
    out = call_tool(w, 'drop_planned', {'field': 'pos', 'document': 'Text 2'})
    assert out.startswith('Error: No planned change writes pos and is in "Text 2". The plan writes')
    assert 'not both' in call_tool(w, 'drop_planned', {'indexes': [1], 'field': 'Gloss'})
    assert 'or a field or a document' in call_tool(w, 'drop_planned', {})
    assert 'No document "Nope"' in call_tool(w, 'drop_planned', {'document': 'Nope'})
    assert len(w.ops) == 5


def test_the_schema_offers_both():
    spec = next(t['function'] for t in TOOLS if t['function']['name'] == 'drop_planned')
    assert set(spec['parameters']['properties']) == {'indexes', 'field', 'document'}
    assert spec['parameters']['required'] == []
