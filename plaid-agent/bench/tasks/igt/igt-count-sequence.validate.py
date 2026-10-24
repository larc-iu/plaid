import handwrite as h
import igtlib as L


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def right(ctx):
    return _say('9 words: pe (COS) is followed by kr 6 times as 1AUGI and 3 times as NMLZ.POSS.')


def wrong_sentences(ctx):
    return _say('7 sentences have it.')


def wrong_count(ctx):
    return _say('6 words.')


def wrong_wrote(ctx):
    L.set_field(ctx, 'Natugu text 1', {'s1.w8.m3': 'COS.PFV'})
    return _say('9 words.')
