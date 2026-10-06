"""The UMR query help says which end of a relation is which (the umr half of
A2-UD-4): a model asking for a node's own role joined its span as the source
and read its children's roles instead."""

from umr_fixtures import umr_ws

from plaid_agent.umr.toolkit import call_tool


def test_the_help_says_the_source_of_a_relation_is_the_parent():
    help_text = call_tool(umr_ws(), 'query_help', {})
    assert "The SOURCE is the PARENT node's span and the TARGET the CHILD's" in help_text
    assert ':ARG0 goes from see-01 to person' in help_text


def test_the_help_says_which_end_of_a_document_level_relation_is_which():
    help_text = call_tool(umr_ws(), 'query_help', {})
    assert 'Its SOURCE is the first node of the triple and its TARGET the last' in help_text
