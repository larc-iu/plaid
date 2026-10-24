import handwrite as h
import igtlib as L


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def right(ctx):
    return _say('In texts 2 and 4, DAT is more frequent: DAT 17 (8 + 9), ERG 13 (6 + 7).')


def wrong_whole_project(ctx):
    return _say('They are equally frequent: ERG 35 and DAT 35.')


def wrong_one_text(ctx):
    return _say('In text 2, DAT 8 and ERG 6.')


def wrong_wrote(ctx):
    L.set_field(ctx, 'Lezgi text 2', {'s1.w1.m1': 'DAT'})
    return _say('DAT 17, ERG 13.')


def wrong_silent(ctx):
    return h.no_plan()
