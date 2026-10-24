import handwrite as h
import udplan

D = 'Russian 2'


def right(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's1.w4', 'head': 0, 'deprel': 'root',
                                     'old_root_head': 4, 'old_root_deprel': 'nsubj'})])


def wrong_deprel(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's1.w4', 'head': 0, 'deprel': 'root',
                                     'old_root_head': 4, 'old_root_deprel': 'nsubj:pass'})])


def wrong_collateral(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's1.w4', 'head': 0, 'deprel': 'root',
                                     'old_root_head': 4, 'old_root_deprel': 'nsubj'}),
                       ('set_head', {'document': D, 'ref': 's1.w2', 'head': 4, 'deprel': 'nmod'})])


def wrong_nothing(ctx):
    return h.no_plan()
