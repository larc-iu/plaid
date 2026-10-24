import handwrite as h
import igtlib as L


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def right(ctx):
    return _say('bisde\'y occurs nine times, e.g. <cite doc="Gitksan text 2" ref="s8.w7"/>.\n\n'
                '**Sentences:** 1, 2, 8, 10, 13, 14, 15, 17 and 18')


def wrong_missing(ctx):
    return _say('Sentences: 1, 2, 10, 13, 14, 15, 17, 18')


def wrong_extra(ctx):
    # Sentences of text 1 mixed in.
    return _say('Sentences: 1, 2, 8, 10, 13, 14, 15, 17, 18, 20')


def wrong_wrote(ctx):
    L.set_field(ctx, 'Gitksan text 2', {'s1.w4.m1': 'grouse.N'})
    return _say('Sentences: 1, 2, 8, 10, 13, 14, 15, 17, 18')


def wrong_silent(ctx):
    return h.no_plan()
