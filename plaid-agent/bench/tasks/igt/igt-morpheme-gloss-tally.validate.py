import handwrite as h
import igtlib as L


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def right(ctx):
    return _say('nz occurs 75 times: NMLZ1 (46), 3AUG (23) and PAS (6).')


def wrong_first_sixty(ctx):
    # The tally of the 60 occurrences a concordance shows.
    return _say('nz: NMLZ1 37, 3AUG 18, PAS 5.')


def wrong_missed_one(ctx):
    return _say('nz: NMLZ1 46, 3AUG 23.')


def wrong_wrote(ctx):
    L.set_field(ctx, 'Natugu text 1', {'s1.w1.m1': 'NMLZ1'})
    return _say('NMLZ1 46, 3AUG 23, PAS 6.')


def wrong_silent(ctx):
    return h.no_plan()
