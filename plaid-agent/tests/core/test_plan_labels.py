"""The label helpers every app's plan shares (core.plan)."""

from plaid_agent.core.plan import by_document, change_of, compact_ops, labelled


def test_labelled_says_where_the_change_starts_whatever_the_place_holds():
    op = labelled('Elicited: LLEC Wordlist s3.w4 "do"', 'Gloss "a" → "b"')
    assert op['label'] == 'Elicited: LLEC Wordlist s3.w4 "do": Gloss "a" → "b"'
    assert change_of(op) == 'Gloss "a" → "b"'
    assert change_of(labelled('', 'Rename')) == 'Rename'
    assert change_of({'label': 'x: y'}) is None
    assert change_of({'label': 'x', 'change_at': 9}) is None


def test_ops_that_differ_only_in_their_labels_fold_together():
    ops = [{'kind': 'k', 'id': i, **labelled(f'D{i}', f'c{i}')} for i in range(4)]
    spec = {'k': {'each': ('id',), 'label': lambda first, members: labelled('D', f'{len(members)} changes')}}
    from plaid_agent.core import plan
    old = plan.COMPACT_ABOVE
    plan.COMPACT_ABOVE = 2
    try:
        group, = compact_ops(ops, spec)
    finally:
        plan.COMPACT_ABOVE = old
    assert group['count'] == 4 and change_of(group) == '4 changes'


def test_by_document_counts_exactly_and_names_the_rest():
    assert by_document([]) == ''
    assert by_document(['A']) == 'In 1 document: "A" 1.'
    assert by_document(['B', 'A', 'B']) == 'In 2 documents: "B" 2, "A" 1.'
    names = ['A'] * 5 + ['B'] * 3 + ['C'] * 2 + ['D']
    assert by_document(names, limit=2) == ('In 4 documents: "A" 5, "B" 3, and 2 more documents '
                                           '(3 changes).')
    assert by_document(names, limit=3) == ('In 4 documents: "A" 5, "B" 3, "C" 2, and 1 more document '
                                           '(1 change).')
