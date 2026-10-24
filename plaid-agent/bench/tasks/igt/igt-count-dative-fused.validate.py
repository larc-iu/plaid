import handwrite as h
import igtlib as L


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def right(ctx):
    return _say('There are **16** datives. DAT is always fused with person and number: DAT.3MINII (6), '
                'DAT.1MINII (4), DAT.1AUGII (4), DAT.12AUGII (1) and DAT.3AUGII (1). The commonest is '
                'DAT.3MINII, third person minimal.')


def wrong_none(ctx):
    # The empty whole-value result taken at its word.
    return _say('There are no datives (DAT) glossed in the project, so no person and number either.')


def wrong_count(ctx):
    return _say('There are 14 datives, most often DAT.3MINII (6).')


def wrong_commonest(ctx):
    return _say('There are 16 datives, most often DAT.1MINII.')


def wrong_wrote(ctx):
    L.set_field(ctx, 'Natugu text 1', {'s6.w16.m1': 'DAT'})
    return _say('There are 16 datives, most often DAT.3MINII (6).')


def wrong_silent(ctx):
    return h.no_plan()
