import handwrite as h
import igtlib as L


def _say(text):
    # The reply of the turn whose plan was applied.
    return {'messages': [], 'display': [
        {'kind': 'user', 'text': '(validation)'},
        {'kind': 'assistant', 'text': text, 'status': 'applied',
         'plan': {'id': 'validation', 'proposed': [['validation']]}}]}


def right(ctx):
    L.patch_entry(ctx, 'kr|NMLZ.POSS', {'pos': 'suffix'})
    return _say('31 morphemes link to kr₂ (NMLZ.POSS): 10 in text 1, 4 in text 2, 8 in text 3, '
                '5 in text 4 and 4 in text 5. I set its pos to suffix.')


def wrong_count(ctx):
    # The person marker's count (36) given instead.
    L.patch_entry(ctx, 'kr|NMLZ.POSS', {'pos': 'suffix'})
    return _say('36 morphemes are linked to it. I set its pos to suffix.')


def wrong_other_homograph(ctx):
    L.patch_entry(ctx, 'kr|', {'pos': 'suffix'})
    return _say('31 morphemes are linked to the nominalizer. I set the pos to suffix.')


def wrong_both(ctx):
    L.patch_entry(ctx, 'kr|NMLZ.POSS', {'pos': 'suffix'})
    L.patch_entry(ctx, 'kr|', {'pos': 'suffix'})
    return _say('31 morphemes are linked to the nominalizer. Both kr entries now have pos suffix.')


def wrong_answer_only(ctx):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': '31 morphemes link to it.',
                                         'status': None, 'plan': None}]}


def wrong_nothing(ctx):
    return h.no_plan()
