import handwrite as h
import igtlib as L


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def right(ctx):
    return _say('Which sentence do you mean? Every sentence of Lezgi text 1 has a third word.')


def right_tells(ctx):
    # a request for the user's choice with no question mark, as glm53-1 phrased ud-fr-clarify-de's
    return _say('Every sentence of Lezgi text 1 has a third word. Tell me which sentence you mean and I will '
                'change its gloss to "son".')


def wrong_guessed(ctx):
    L.set_field(ctx, 'Lezgi text 1', {'s2.w3.m1': 'son'})
    return h.applied_plan()


def wrong_guessed_then_asked(ctx):
    L.set_field(ctx, 'Lezgi text 1', {'s1.w2.m1': 'son'})
    return _say('I changed sentence 1. Did you mean another sentence?')


def wrong_announces(ctx):
    return _say('Every sentence of Lezgi text 1 has a third word. I will change the one in sentence 1 to "son".')


def wrong_no_question(ctx):
    return _say('I cannot do that.')
