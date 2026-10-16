"""A document named as it would be typed resolves to the stored name: a model
wrote "children's" for a name with ’ and "COMPLETE:Pear_Story_01" for
"COMPLETE: Pear_Story_01" and was refused eight times (2026-10-12 survey)."""
import pytest

from fixtures import FakeClient, fake_ws
from plaid_agent.core.tools import ToolError

NAMES = ['The children’s story', 'COMPLETE: Pear_Story_01', 'COMPLETE: Pear_Story_02',
         'Frog “where are you” – part 1', 'Ab:c', 'Ab : c']


def _ws():
    w = fake_ws(FakeClient())
    w._doc_list = [{'id': f'd{i}', 'name': n} for i, n in enumerate(NAMES)]
    return w


@pytest.mark.parametrize('typed, doc', [
    ("the children's story", 'd0'),
    ('COMPLETE:Pear_Story_01', 'd1'),
    ('complete :  pear_story_02', 'd2'),
    ('Frog "where are you" - part 1', 'd3'),
    ('Ab : c', 'd5'),
])
def test_a_typed_name_resolves(typed, doc):
    assert _ws().resolve_document_id(typed) == doc


def test_a_loose_colon_that_names_two_documents_is_refused():
    with pytest.raises(ToolError, match='Several documents'):
        _ws().resolve_document_id('ab: c')


def test_a_miss_leads_with_the_closest_names():
    with pytest.raises(ToolError) as e:
        _ws().resolve_document_id('Pear_Story_03')
    said = str(e.value)
    assert said.startswith('No document "Pear_Story_03". Closest: "COMPLETE: Pear_Story_0')
    assert said.index('Closest:') < said.index('Documents:')


@pytest.mark.parametrize('typed, names', [
    ("children's", ['The children’s story']),
    ('complete:pear', ['COMPLETE: Pear_Story_01', 'COMPLETE: Pear_Story_02']),
    ('"where are you" - part', ['Frog “where are you” – part 1']),
    ('Ab:c', ['Ab : c', 'Ab:c']),
])
def test_list_documents_folds_the_pattern_as_a_name_resolves(typed, names):
    """"Man's hunting story" listed nothing in 3 of 3 runs (2026-10-13 survey)."""
    from plaid_agent.igt.toolkit import call_tool
    out = call_tool(_ws(), 'list_documents', {'pattern': typed})
    from plaid_agent.core.bidi import for_model
    assert [for_model(line).rsplit(' (', 1)[0].strip()[1:-1] for line in out.splitlines()[1:]] == names, out
    assert call_tool(_ws(), 'list_documents', {'pattern': 'zzz'}) == 'No documents matched.'


def test_igt_names_a_shared_name_with_its_id_in_the_form_document_reads_back():
    """REV3-AGENT-5 in igt: the list, a read's header, the unknown-document
    refusal, a reference error and recent_changes print '"Text 1" (d2)', and
    document= takes it back."""
    from test_igt_rules import _ws
    from plaid_agent.core.bidi import for_model
    from plaid_agent.igt.toolkit import call_tool
    client, w = _ws({'sp-g1': 'Ali'})
    client._documents['d2']['name'] = 'Text 1'
    w._documents = None
    run = lambda name, args: for_model(str(call_tool(w, name, args)))  # noqa: E731
    assert run('list_documents', {}).splitlines()[1:] == ['  "Text 1" (d1)', '  "Text 1" (d2)']
    assert run('read_document', {'document': '"Text 1" (d2)'}).startswith('Document "Text 1" (d2):')
    assert run('read_document', {'document': 'Text 1 (d2)'}).startswith('Document "Text 1" (d2):')
    assert run('read_document', {'document': 'Nada'}).endswith('Documents: "Text 1" (d1), "Text 1" (d2)')
    out = run('set_field', {'document': 'd2', 'refs': ['s9.w1'], 'field': 'Gloss', 'value': 'x'})
    assert 'document "Text 1" (d2) has 2 sentences' in out, out
    assert '"Text 1" (d1): ' in run('recent_changes', {})
