"""read_document prints the format legend on the turn's first read and a
pointer on later ones: the legend cost about a kilobyte of every read
(2026-10-12 survey)."""
from fixtures import FakeClient, fake_ws
from plaid_agent.igt.project import FORMAT_AS_BEFORE, FORMAT_LEGEND
from plaid_agent.igt.toolkit import call_tool


def test_the_legend_is_printed_once_a_turn():
    w = fake_ws(FakeClient())
    first = call_tool(w, 'read_document', {'document': 'd1'})
    again = call_tool(w, 'read_document', {'document': 'd1', 'from_sentence': 1})
    assert FORMAT_LEGEND in first and FORMAT_AS_BEFORE not in first
    assert FORMAT_LEGEND not in again and FORMAT_AS_BEFORE in again
    # A new turn is a new workspace, and reads it again.
    assert FORMAT_LEGEND in call_tool(fake_ws(FakeClient()), 'read_document', {'document': 'd1'})


def test_a_read_that_shows_no_sentence_leaves_the_legend_for_the_next():
    w = fake_ws(FakeClient())
    call_tool(w, 'read_document', {'document': 'd1', 'from_sentence': 99})
    assert FORMAT_LEGEND in call_tool(w, 'read_document', {'document': 'd1'})
