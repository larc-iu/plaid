"""The search step's label is what the tool resolved its ``where`` to, not a
word list (REV-SVA-6): a field named like a kind ("Surface") is labelled as the
field the tool searched, and "field:Gloss" shows no prefix."""

import pytest

from fixtures import FakeClient, fake_ws
from plaid_agent.igt.toolkit import call_tool


def _searched(w, where, **more):
    w.step_label = None
    out = call_tool(w, 'search', {'pattern': 'a', **({'where': where} if where is not None else {}), **more})
    assert not out.startswith('Error'), out
    return (w.step_label or '').replace('⁨', '').replace('⁩', '')


@pytest.mark.parametrize('where, label', [
    (None, 'Searched the baseline for “a”'), ('words', 'Searched the baseline for “a”'),
    ('morphemes', 'Searched morpheme forms for “a”'), ('lexicon', 'Searched the lexicon for “a”'),
    ('Gloss', 'Searched Gloss for “a”'), ('field:Gloss', 'Searched Gloss for “a”'),
])
def test_search_labels_what_the_tool_resolved(where, label):
    """REV-SVA-6: the label came from a word list while the tool reads the
    project's fields first."""
    assert _searched(fake_ws(FakeClient()), where) == label


def test_a_field_named_like_a_kind_is_labelled_as_the_field_the_tool_searched(monkeypatch):
    import dataclasses
    w = fake_ws(FakeClient())
    fields = w.project.fields
    key = next(k for k, f in fields.items() if f.name == 'Gloss')
    monkeypatch.setitem(fields, key, dataclasses.replace(fields[key], name='Surface', base_name='Surface'))
    assert _searched(w, 'Surface') == 'Searched Surface for “a”'
    assert _searched(w, 'surface') == 'Searched surface for “a”'


def test_a_search_held_to_documents_names_them():
    w = fake_ws(FakeClient())
    assert _searched(w, None, document='Text 1') == 'Searched the baseline for “a” in “Text 1”'
