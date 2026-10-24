import handwrite as h
import udplan

D = 'Russian 2'
RIGHT = (('s18.w4', 'якобит'), ('s18.w9', 'замок'), ('s18.w10', 'тюрьма'))


def right(ctx):
    udplan.apply(ctx, [('set_field', {'document': D, 'refs': [r], 'field': 'lemma', 'value': v}) for r, v in RIGHT])


def wrong_two_of_three(ctx):
    udplan.apply(ctx, [('set_field', {'document': D, 'refs': [r], 'field': 'lemma', 'value': v})
                       for r, v in RIGHT[:2]])


def wrong_shifted(ctx):
    udplan.apply(ctx, [('set_field', {'document': D, 'refs': ['s18.w4'], 'field': 'lemma', 'value': 'якобит'}),
                       ('set_field', {'document': D, 'refs': ['s18.w8'], 'field': 'lemma', 'value': 'замок'}),
                       ('set_field', {'document': D, 'refs': ['s18.w10'], 'field': 'lemma', 'value': 'тюрьма'})])


def wrong_nothing(ctx):
    return h.no_plan()
