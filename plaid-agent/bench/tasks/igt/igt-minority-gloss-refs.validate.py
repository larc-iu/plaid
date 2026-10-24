import handwrite as h
import igtlib as L


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def right(ctx):
    return _say('на is glossed AOC 7 times, all others AOR.\n\nText 2: 6, 14, 19\nText 3: 11\nText 4: 9, 20')


def wrong_only_lagana(ctx):
    # Only the occurrences in лагьана, the commonest word.
    return _say('Text 2: 6, 14, 19')


def wrong_extra(ctx):
    return _say('Text 2: 6, 14, 19\nText 3: 11\nText 4: 9, 17, 20')


def wrong_wrote(ctx):
    L.set_field(ctx, 'Lezgi text 2', {'s6.w3.m2': 'AOR'})
    return _say('Text 2: 6, 14, 19\nText 3: 11\nText 4: 9, 20')


def wrong_silent(ctx):
    return h.no_plan()
