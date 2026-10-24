import handwrite as h
import udplan

D = 'Russian 2'


def right(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's11.w5', 'head': 3, 'deprel': 'iobj'})])


def wrong_deprel(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's11.w5', 'head': 3, 'deprel': 'obl'})])


def wrong_head(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's11.w5', 'head': 4, 'deprel': 'iobj'})])


def wrong_collateral(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's11.w5', 'head': 3, 'deprel': 'iobj'}),
                       ('set_head', {'document': D, 'ref': 's11.w4', 'head': 3, 'deprel': 'obj'})])


def wrong_nothing(ctx):
    return h.no_plan()
