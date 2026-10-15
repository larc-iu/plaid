"""set_field with several fields at once (survey item 3, 0dc96de7): retagging
one word and its morpheme took six set_field calls. ``values`` maps field
names to values, each field goes to the refs of its own scope, one plan step
per field and target, all or nothing."""

from fixtures import fake_ws, FakeClient

from plaid_agent.core.bidi import for_model
from plaid_agent.igt.toolkit import call_tool
from plaid_agent.igt.trace import describe_step


def ws():
    return fake_ws(FakeClient())


def test_one_call_sets_word_and_morpheme_fields_each_on_its_scope():
    w = ws()
    out = call_tool(w, 'set_field', {'document': 'Text 1', 'refs': ['s1.w2', 's1.w1.m2'],
                                     'values': {'Gloss': 'fish', 'Morph Gloss': 'PL'}})
    assert out.startswith('Planned 2 changes'), out
    assert [(o['layer_id'], o['token_id'], o['value']) for o in w.ops] == [
        ('sl-gloss', 'w-2', 'fish'), ('sl-mgloss', 'm-1b', 'PL')]


def test_several_refs_of_one_scope_take_the_field_each():
    w = ws()
    out = call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w1', 's1.w2', 's2'],
                                     'values': {'Gloss': 'X', 'Translation': 'Nets.'}})
    assert out.startswith('Planned 3 changes'), out
    assert sorted(o['token_id'] for o in w.ops) == ['s-2', 'w-1', 'w-2']


def test_a_bad_field_or_unmatched_scope_plans_nothing():
    w = ws()
    out = call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'],
                                     'values': {'Gloss': 'fish', 'Nope': 'x'}})
    assert 'No field named "Nope"' in out and w.ops == []
    out = for_model(call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'],
                                               'values': {'Gloss': 'fish', 'Morph Gloss': 'PL'}}))
    assert '"Morph Gloss" is a Morpheme field and no ref is a morpheme (sN.wN.mN)' in out and w.ops == []
    out = for_model(call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2', 's2'],
                                               'values': {'Gloss': 'fish'}}))
    assert 's2 is a sentence, and no field in values is a Sentence field. Fields given: Gloss (Word).' in out
    assert w.ops == []


def test_field_and_values_together_or_neither_is_refused():
    w = ws()
    out = call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss',
                                     'values': {'Gloss': 'fish'}})
    assert 'not both' in out
    assert 'Give field and value, or values' in call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2']})
    assert 'Give value' in call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s1.w2'], 'field': 'Gloss'})
    assert w.ops == []


def test_values_reach_a_planned_analysis_as_set_field_does():
    w = ws()
    call_tool(w, 'set_analysis', {'document': 'd1', 'ref': 's2.w1', 'morphemes': [
        {'form': 'gam', 'type': 'stem'}, {'form': 'ar', 'type': 'suffix'}]})
    out = call_tool(w, 'set_field', {'document': 'd1', 'refs': ['s2.w1', 's2.w1.m2'],
                                     'values': {'Gloss': 'fishes', 'Morph Gloss': 'PL'}})
    assert out.startswith('Planned 2 changes'), out
    analysis = next(o for o in w.ops if o['kind'] == 'set_analysis')
    assert analysis['morphemes'][1]['fields'] == [{'layer_id': 'sl-mgloss', 'value': 'PL'}]
    assert any(o['kind'] == 'set_span' and o['token_id'] == 'w-4' for o in w.ops)


def test_the_trace_names_every_field():
    line = describe_step('set_field', {'document': 'd1', 'refs': ['s1.w2', 's1.w1.m2'],
                                       'values': {'Gloss': 'fish', 'Morph Gloss': 'PL'}})
    text = line['text'] if isinstance(line, dict) else str(line)
    assert text == "Planned Gloss = “fish”, Morph Gloss = “PL” on 2 items in “d1”"
