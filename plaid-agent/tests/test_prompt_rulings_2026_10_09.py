"""What the 2026-10-08 benchmark (B3) asked of the prompts and the tool
descriptions, ranked by Luke on 2026-10-09."""

from plaid_agent.umr.toolkit import TOOLS as UMR_TOOLS


def _description(tools, name):
    return next(t['function']['description'] for t in tools if t['function']['name'] == name)


def test_add_triple_shows_a_triple_between_two_events():
    """umr-doc-temporal: one run reversed two right triples after reading an
    example with document-creation-time only."""
    d = _description(UMR_TOOLS, 'add_triple')
    assert '(s4e :before s2e) between two events says s2e happened before s4e' in d
