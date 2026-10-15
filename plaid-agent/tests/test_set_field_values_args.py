"""set_field(values=...) refuses what would plan one change as two
(H16-IGT-TOOLS-9, H16-REVIEW-7): two spellings of one field, a field with
no value, value beside values. A ref named twice is one target."""

from fixtures import FakeClient, fake_ws

from plaid_agent.igt.toolkit import call_tool


def _set(w, **a):
    return call_tool(w, 'set_field', {'document': 'd1', **a})


def test_two_spellings_of_one_field_are_refused_naming_both():
    w = fake_ws(FakeClient())
    out = _set(w, refs=['s1.w2'], values={'Gloss': 'a', 'gloss': 'b'})
    assert out == 'Error: values: "Gloss" and "gloss" both name the field Gloss. Give it once.', out
    assert w.ops == []


def test_a_field_with_no_value_and_value_beside_values_are_refused():
    w = fake_ws(FakeClient())
    out = _set(w, refs=['s1.w2'], values={'Gloss': 'a', 'Translation': None})
    assert out.startswith('Error: values: "Translation" has no value.'), out
    out = _set(w, refs=['s1.w2'], values={'Gloss': 'a'}, value='b')
    assert out == 'Error: Give field and value, or values, not both.', out
    assert w.ops == []


def test_a_ref_named_twice_is_one_change_and_nothing_is_superseded():
    w = fake_ws(FakeClient())
    out = _set(w, refs=['s1.w2', 's1.w2'], values={'Gloss': 'fish'})
    assert out.startswith('Planned 1 change') and 'superseded' not in out, out
    out = _set(w, refs=['s1.w3', 's1.w3'], field='Gloss', value='see')
    assert 'Planned 1 change' in out and 'superseded' not in out, out


def test_an_orthography_named_as_a_field_points_to_set_orthography():
    w = fake_ws(FakeClient())
    out = _set(w, refs=['s1.w2'], values={'IPA': 'gam'})
    assert out == 'Error: "IPA" is an orthography, not a field: set it with set_orthography.', out
