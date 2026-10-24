import handwrite as h
import igtlib as L


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def right(ctx):
    return _say('з carries three glosses:\n\n| gloss | count |\n|---|---|\n| DAT | 35 |\n| INF | 2 |\n| IMC | 1 |')


def wrong_missing_gloss(ctx):
    return _say('з is glossed DAT 35 times and INF 2 times.')


def wrong_count(ctx):
    return _say('DAT: 34, INF: 2, IMC: 1.')


def wrong_wrote(ctx):
    L.set_field(ctx, 'Lezgi text 1', {'s1.w2.m1': 'DAT'})
    return _say('DAT: 35, INF: 2, IMC: 1.')
