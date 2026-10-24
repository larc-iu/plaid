import handwrite as h
import igtlib as L


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def right(ctx):
    return _say('The ERG sense (ди 1.1) has the most: 35 morphemes link to it, against 19 each for OBL and DIR.')


def wrong_sense(ctx):
    return _say('The OBL sense has the most, 35 links.')


def wrong_count(ctx):
    return _say('The ERG sense has the most: 73 morphemes.')


def wrong_wrote(ctx):
    L.patch_entry(ctx, 'ди|ERG', {'pos': 'case'})
    return _say('The ERG sense has the most: 35 morphemes link to it.')


def wrong_silent(ctx):
    return h.no_plan()
