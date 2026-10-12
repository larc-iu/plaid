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
