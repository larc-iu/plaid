import handwrite as h
import igtlib as L


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def right(ctx):
    return _say('23 morphemes are glossed exactly NEG across the five texts.')


def wrong_count(ctx):
    return _say('14 morphemes are glossed NEG (all of them tr).')


def wrong_wrote(ctx):
    L.set_field(ctx, 'Natugu text 1', {'s1.w2.m1': 'NEG'})
    return _say('23 morphemes are glossed exactly NEG.')


def wrong_silent(ctx):
    return h.no_plan()
