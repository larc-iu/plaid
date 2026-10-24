import handwrite as h
import udplan

D = 'French 1'


def right(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's4.w20', 'head': 18, 'deprel': 'amod'}),
                       ('set_head', {'document': D, 'ref': 's20.w20', 'head': 18, 'deprel': 'advcl'})])


def wrong_hydrostatique(ctx):
    # importante attached to hydrostatique, the word before it.
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's4.w20', 'head': 19, 'deprel': 'amod'}),
                       ('set_head', {'document': D, 'ref': 's20.w20', 'head': 18, 'deprel': 'advcl'})])


def wrong_one(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's20.w20', 'head': 18, 'deprel': 'advcl'})])


def wrong_collateral(ctx):
    # Both, and "totale" moved under pression too.
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's4.w20', 'head': 18, 'deprel': 'amod'}),
                       ('set_head', {'document': D, 'ref': 's4.w15', 'head': 18, 'deprel': 'amod'}),
                       ('set_head', {'document': D, 'ref': 's20.w20', 'head': 18, 'deprel': 'advcl'})])


def wrong_deprel(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's4.w20', 'head': 18, 'deprel': 'amod'}),
                       ('set_head', {'document': D, 'ref': 's20.w20', 'head': 18, 'deprel': 'xcomp'})])


def wrong_nothing(ctx):
    return h.no_plan()
