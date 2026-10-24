import handwrite as h
import udplan

D = 'Russian 2'


def right(ctx):
    udplan.apply(ctx, [('set_feature', {'document': D, 'refs': ['s7.w14'], 'feature': 'Case', 'value': 'Gen'})])


def wrong_dropped_features(ctx):
    udplan.apply(ctx, [('set_field', {'document': D, 'refs': ['s7.w14'], 'field': 'features',
                                      'value': 'Case=Gen'})])


def wrong_word(ctx):
    udplan.apply(ctx, [('set_feature', {'document': D, 'refs': ['s7.w13'], 'feature': 'Case', 'value': 'Gen'})])


def wrong_collateral(ctx):
    udplan.apply(ctx, [('set_feature', {'document': D, 'refs': ['s7.w14'], 'feature': 'Case', 'value': 'Gen'}),
                       ('set_field', {'document': D, 'refs': ['s7.w14'], 'field': 'lemma', 'value': 'жатвы'})])
