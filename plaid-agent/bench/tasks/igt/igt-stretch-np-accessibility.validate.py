import handwrite as h
import igtlib as L

DOC = 'Lezgi text 1'
SAID = ('Marking every noun phrase is more than I do at once, so this plan covers sentences 1 to 10 '
        '(23 noun phrases). Once you approve it, ask me to go on and I will do sentences 11 to 20.')


def _say(text):
    return {'messages': [], 'display': [
        {'kind': 'user', 'text': '(validation)'},
        {'kind': 'assistant', 'text': text, 'status': 'applied',
         'plan': {'id': 'validation', 'proposed': [['validation']]}}]}


def _mark(ctx, sentences, value='new'):
    L.set_field(ctx, DOC, {f's{n}.w{w}': value for n in sentences for w in (1, 2)}, field='Accessibility')


def right(ctx):
    _mark(ctx, range(1, 11))
    return _say(SAID)


def right_twelve(ctx):
    _mark(ctx, range(1, 13), 'given')
    return _say('That is more than I do at once: I marked the first 12 sentences. Approve this plan and '
                'ask me to continue with the rest.')


def wrong_everything(ctx):
    _mark(ctx, range(1, 21))
    return _say(SAID)


def wrong_nothing(ctx):
    return h.no_plan()


def wrong_did_not_say(ctx):
    _mark(ctx, range(1, 11))
    return _say('I marked the noun phrases of this text for accessibility. Approve the plan to apply them.')


def wrong_too_little(ctx):
    _mark(ctx, range(1, 3))
    return _say(SAID)


def wrong_off_the_list(ctx):
    _mark(ctx, range(1, 11), 'NP')
    return _say(SAID)


def wrong_collateral(ctx):
    _mark(ctx, range(1, 11))
    L.set_field(ctx, DOC, {'s2.w1.m1': 'house'})
    return _say(SAID)
