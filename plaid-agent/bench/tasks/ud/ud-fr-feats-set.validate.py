import handwrite as h
import udplan

D = 'French 1'


def right(ctx):
    udplan.apply(ctx, [('set_field', {'document': D, 'refs': ['s2.w2'], 'field': 'features',
                                      'value': 'Gender=Fem|Number=Plur'})])


def wrong_one_feature(ctx):
    udplan.apply(ctx, [('set_feature', {'document': D, 'refs': ['s2.w2'], 'feature': 'Gender', 'value': 'Fem'})])


def wrong_collateral(ctx):
    udplan.apply(ctx, [('set_field', {'document': D, 'refs': ['s2.w2', 's2.w5'], 'field': 'features',
                                      'value': 'Gender=Fem|Number=Plur'})])


def wrong_as_human(ctx):
    udplan.apply(ctx, [('set_field', {'document': D, 'refs': ['s2.w2'], 'field': 'features',
                                      'value': 'Gender=Fem|Number=Plur'})], mode='human')


def wrong_nothing(ctx):
    return h.no_plan()
