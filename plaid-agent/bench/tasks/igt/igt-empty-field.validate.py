import handwrite as h
import igtlib as L


def _say(text):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': None, 'plan': None}]}


def right(ctx):
    return _say('The Translation (ru) field is empty in every text, so no sentence has a Russian translation '
                'to search. The English translations are in Translation.')


def wrong_searched_english(ctx):
    return _say('Sentence 4 of Lezgi text 2 mentions a dog.')


def wrong_wrote(ctx):
    L.set_field(ctx, 'Lezgi text 1', {'s1': 'собака'}, field='Translation (ru)')
    return _say('The Translation (ru) field is empty.')


def wrong_silent(ctx):
    return h.no_plan()
