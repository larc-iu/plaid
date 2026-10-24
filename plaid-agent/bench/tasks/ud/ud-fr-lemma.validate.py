import handwrite as h
import udplan

D = 'French 1'


def right(ctx):
    udplan.apply(ctx, [('set_field', {'document': D, 'refs': ['s2.w9'], 'field': 'lemma', 'value': 'différer'})])


def wrong_word(ctx):
    udplan.apply(ctx, [('set_field', {'document': D, 'refs': ['s2.w3'], 'field': 'lemma', 'value': 'différer'})])


def wrong_accent(ctx):
    udplan.apply(ctx, [('set_field', {'document': D, 'refs': ['s2.w9'], 'field': 'lemma', 'value': 'differer'})])


def wrong_collateral(ctx):
    udplan.apply(ctx, [('set_field', {'document': D, 'refs': ['s2.w9'], 'field': 'lemma', 'value': 'différer'}),
                       ('set_field', {'document': D, 'refs': ['s2.w9'], 'field': 'upos', 'value': 'AUX'})])


def wrong_nothing(ctx):
    return h.no_plan()
