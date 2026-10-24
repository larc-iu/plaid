import handwrite as h
import udplan

D = 'French 1'
ANIMALS = ['s4.w35', 's4.w38', 's4.w41', 's4.w44']


def right(ctx):
    udplan.apply(ctx, [('set_feature', {'document': D, 'refs': ANIMALS, 'feature': 'Number', 'value': 'Plur'})])


def wrong_bundle_dropped(ctx):
    # "Mark as plural" taken as the whole FEATS: Gender is lost.
    udplan.apply(ctx, [('set_field', {'document': D, 'refs': ANIMALS, 'field': 'features', 'value': 'Number=Plur'})])


def wrong_three(ctx):
    udplan.apply(ctx, [('set_feature', {'document': D, 'refs': ANIMALS[:3], 'feature': 'Number', 'value': 'Plur'})])


def wrong_collateral(ctx):
    # The four, and "vie" (oasis de vie) made plural as well.
    udplan.apply(ctx, [('set_feature', {'document': D, 'refs': ANIMALS + ['s4.w5'], 'feature': 'Number',
                                        'value': 'Plur'})])


def wrong_nothing(ctx):
    return h.no_plan()
