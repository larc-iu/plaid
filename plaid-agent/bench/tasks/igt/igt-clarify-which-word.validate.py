import handwrite as h
import igtlib as L


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def right(ctx):
    return _say('Which sentence do you mean? Every sentence of Lezgi text 1 has a third word.')


def wrong_guessed(ctx):
    L.set_field(ctx, 'Lezgi text 1', {'s2.w3.m1': 'son'})
    return h.applied_plan()


def wrong_guessed_then_asked(ctx):
    L.set_field(ctx, 'Lezgi text 1', {'s1.w2.m1': 'son'})
    return _say('I changed sentence 1. Did you mean another sentence?')


def wrong_no_question(ctx):
    return _say('I cannot do that.')
