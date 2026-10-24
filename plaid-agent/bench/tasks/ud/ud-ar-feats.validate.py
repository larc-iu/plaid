import handwrite as h
import udplan

D = 'Arabic 1'
V = 'Case=Acc|Definite=Cons|Number=Sing'


def right(ctx):
    udplan.apply(ctx, [('set_field', {'document': D, 'refs': ['s1.w7'], 'field': 'features', 'value': V})])


def wrong_word(ctx):
    udplan.apply(ctx, [('set_field', {'document': D, 'refs': ['s1.w8'], 'field': 'features', 'value': V})])


def wrong_half(ctx):
    udplan.apply(ctx, [('set_feature', {'document': D, 'refs': ['s1.w7'], 'feature': 'Case', 'value': 'Acc'})])


def wrong_collateral(ctx):
    udplan.apply(ctx, [('set_field', {'document': D, 'refs': ['s1.w7', 's1.w5'], 'field': 'features',
                                      'value': V})])
