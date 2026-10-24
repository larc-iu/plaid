import handwrite as h
import igtlib as L


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


RIGHT = 'Text 1: 9, 13\nText 2: 2, 7\nText 3: 8\nText 4: 8\nText 5: 6'


def right(ctx):
    return _say('No gloss is IMPV on its own: it is part of call.IMPV, put.IMPV, take.IMPV, order.IMPV, '
                'cut.IMPV and bring.IMPV.Q, 8 morphemes in 7 sentences.\n\n' + RIGHT)


def wrong_none(ctx):
    return _say('No morpheme is glossed IMPV in any text.')


def wrong_imp_too(ctx):
    # IMP counted as well (choose.IMP, say.IMP, run.IMP and the bare IMP).
    return _say('Text 1: 9, 11, 13, 20\nText 2: 2, 7, 9\nText 3: 5, 8\nText 4: 8, 15\nText 5: 6')


def wrong_missed_text(ctx):
    return _say('Text 1: 9, 13\nText 2: 2, 7\nText 3: 8\nText 4: 8')


def wrong_wrote(ctx):
    L.set_field(ctx, 'Lezgi text 2', {'s2.w2.m1': 'cut.IMP'})
    return _say(RIGHT)


def wrong_silent(ctx):
    return h.no_plan()
