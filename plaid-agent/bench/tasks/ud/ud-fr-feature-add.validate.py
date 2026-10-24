import handwrite as h
import udplan

D = 'French 1'


def right(ctx):
    udplan.apply(ctx, [('set_feature', {'document': D, 'refs': ['s8.w8'], 'feature': 'Tense', 'value': 'Pres'})])


def wrong_replaced_all(ctx):
    udplan.apply(ctx, [('set_field', {'document': D, 'refs': ['s8.w8'], 'field': 'features',
                                      'value': 'Tense=Pres'})])


def wrong_value(ctx):
    udplan.apply(ctx, [('set_feature', {'document': D, 'refs': ['s8.w8'], 'feature': 'Tense', 'value': 'Past'})])


def wrong_collateral(ctx):
    udplan.apply(ctx, [('set_feature', {'document': D, 'refs': ['s8.w8', 's8.w9'], 'feature': 'Tense',
                                        'value': 'Pres'})])


def wrong_nothing(ctx):
    return h.no_plan()
