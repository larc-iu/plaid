"""run_code's load() and the document tools refuse what is not a name or id
by naming the argument (A1-IGT polish)."""

from fixtures import FakeClient, scan_ws

from plaid_agent.igt.toolkit import call_tool


def test_the_codes_load_names_the_argument_when_handed_what_documents_returns():
    """A1-IGT polish: load(documents()[0]) said "'dict' object has no
    attribute 'lower'"."""
    from plaid_agent.igt import sandbox as sb
    import pytest
    w = scan_ws(FakeClient())
    api = sb.api(w)
    with pytest.raises(ValueError) as e:
        api['load'](api['documents']()[0])
    assert str(e.value) == ('document must be a document\'s name or id, as text. For an entry of documents(), '
                            'pass its "id".')
    assert call_tool(w, 'read_document', {'document': ['Text 1']}).startswith('Error: document must be')
