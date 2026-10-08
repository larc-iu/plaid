"""A relation UMR 2.0 renamed is refused with its new name.

The UMR 2.0 release renamed ``:poss`` to ``:possessor`` (and ``:location`` to
``:place``), but its fieldwork graphs and the guidelines still write the old
name, so an assistant reading such a document writes ``:poss`` too. The app
refuses a new ``:poss`` and keeps a stored one, and so does the assistant.
The refusal says why rather than calling the relation unknown to UMR, which
the document in front of the model seems to contradict (bench
umr-hard-mixed-path).
"""

from umr_fixtures import SENTENCE_1_PENMAN, umr_client, umr_ws

from plaid_agent.umr.toolkit import call_tool
from plaid_client.workflows.umr.inventory import (RENAMED_RELATIONS, is_known_relation,
                                                  unknown_relation_problem)


def test_every_new_name_is_a_relation_and_no_old_one_is():
    for old, new in RENAMED_RELATIONS.items():
        assert is_known_relation(new)
        assert not is_known_relation(old)


def test_the_refusal_names_the_new_name_and_its_inverse():
    assert unknown_relation_problem(':poss') == (
        "Unknown relation ':poss': UMR 2.0 renamed it :possessor.")
    assert unknown_relation_problem(':poss-of') == (
        "Unknown relation ':poss-of': UMR 2.0 renamed it :possessor-of.")
    assert 'renamed it :place' in unknown_relation_problem(':location')
    assert 'Did you mean :possessor?' in unknown_relation_problem(':posessor')


def test_apply_penman_refuses_a_new_poss_with_the_new_name():
    ws = umr_ws(umr_client())
    out = call_tool(ws, 'apply_penman', {
        'document': 'Story', 'sentence': 1,
        'text': SENTENCE_1_PENMAN.replace(':aspect performance',
                                          ':aspect performance\n    :poss (s1x / person)')})
    assert "s1b: Unknown relation ':poss': UMR 2.0 renamed it :possessor." in out
    assert ws.ops == []
