"""What the 2026-10-08 benchmark (B3) asked of the prompts and the tool
descriptions, ranked by Luke on 2026-10-09: igt asks which sentence when a
request names none, every assistant plans the value the user states over
the corpus, umr says no tool sets alignment and names :possessor first, and
add_triple shows the direction of a triple between two events."""

from plaid_agent.igt import prompt as igt_prompt
from plaid_agent.ud import prompt as ud_prompt
from plaid_agent.umr import prompt as umr_prompt
from plaid_agent.umr.toolkit import TOOLS as UMR_TOOLS


def _description(tools, name):
    return next(t['function']['description'] for t in tools if t['function']['name'] == name)


def test_igt_asks_which_sentence_when_a_request_names_none():
    """igt-clarify-which-word failed 3 of 3: "the third word" with no
    sentence was taken as sentence 1 and planned."""
    assert 'The open document is a whole text, not a sentence.' in igt_prompt.SYSTEM
    assert 'ask which sentence, and plan nothing, rather than picking one' in igt_prompt.SYSTEM


def test_every_assistant_plans_the_value_the_user_states():
    for system in (igt_prompt.SYSTEM, ud_prompt.SYSTEM, umr_prompt.SYSTEM):
        assert '- WHAT THE USER STATES WINS. A value the user gives (' in system
        assert 'plan what they said and mention the difference' in system
    assert '(a concept, an aspect, a role, a modal strength)' in umr_prompt.SYSTEM


def test_umr_says_no_tool_sets_alignment_and_how_the_user_does_it():
    """umr-align-request invented a set_alignment tool or ~4 in PENMAN in
    6 of 6 runs."""
    assert 'NO TOOL SETS ALIGNMENT' in umr_prompt.SYSTEM
    assert 'focus the node, press u, click its words, then Done' in umr_prompt.SYSTEM


def test_apply_penman_names_possessor_before_anything_else():
    """:poss cost a call in 11 of 12 runs that needed a possessor."""
    d = _description(UMR_TOOLS, 'apply_penman')
    assert d.index(':possessor') < 150 and '(:poss for :possessor)' not in d


def test_add_triple_shows_a_triple_between_two_events():
    """umr-doc-temporal: one run reversed two right triples after reading an
    example with document-creation-time only."""
    d = _description(UMR_TOOLS, 'add_triple')
    assert '(s4e :before s2e) between two events says s2e happened before s4e' in d
