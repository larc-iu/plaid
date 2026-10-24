import handwrite as h
import udplan

D = 'French 2'


def right(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's7.w3', 'head': 0, 'deprel': 'root',
                                     'old_root_head': 3, 'old_root_deprel': 'aux:pass'})])


def wrong_old_root_deprel(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's7.w3', 'head': 0, 'deprel': 'root',
                                     'old_root_head': 3, 'old_root_deprel': 'aux'})])


def wrong_collateral(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's7.w3', 'head': 0, 'deprel': 'root',
                                     'old_root_head': 3, 'old_root_deprel': 'aux:pass'}),
                       ('set_head', {'document': D, 'ref': 's7.w1', 'head': 3, 'deprel': 'nsubj'})])


def wrong_nothing(ctx):
    return h.no_plan()
