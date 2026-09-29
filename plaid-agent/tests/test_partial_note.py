"""What the model is told of a plan that stopped partway (Luke's ruling Q4).

A change counts as written only when every batch holding its writes
committed. One whose first batch committed and whose second did not is
partly in the document: an igt analysis whose morphemes landed and whose
morpheme glosses did not (conc-2026-09-29 REV-F-PY, checked live). The
note must not tell the model such a change was not written, or its next
plan starts from a document it has misread.
"""

from plaid_agent.core.conversation import partial_note


def test_a_change_not_written_in_full_is_not_said_to_be_unwritten():
    note = partial_note(['entry', 'analysis', 'gloss'], [0, 2], False, 'HTTP 500 boom')
    assert 'Not written:' not in note
    assert 'Not written in full: analysis.' in note
    assert 'Written: entry; gloss.' in note


def test_a_lost_answer_does_not_say_what_may_have_landed_was_not_written():
    note = partial_note(['lemma', 'head'], [0], True, 'the server did not answer')
    assert 'Not written' not in note
    assert 'Not known to be written in full: head.' in note
