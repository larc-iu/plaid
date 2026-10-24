import handwrite as h
import udplan

D = 'French 1'


def mend(ctx, colon_head=3):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's19.w2', 'head': 0, 'deprel': 'root'}),
                       ('set_head', {'document': D, 'ref': 's19.w13', 'head': 2, 'deprel': 'punct'}),
                       ('set_head', {'document': D, 'ref': 's18.w25', 'head': colon_head, 'deprel': 'punct'})])


def right(ctx):
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's18.w26'})])
    mend(ctx)


def wrong_colon_moves(ctx):
    # Split at the colon itself: it starts the new sentence.
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's18.w25'})])
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's19.w3', 'head': 0, 'deprel': 'root'}),
                       ('set_head', {'document': D, 'ref': 's19.w14', 'head': 3, 'deprel': 'punct'})])


def wrong_root_only(ctx):
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's18.w26'})])
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's19.w2', 'head': 0, 'deprel': 'root'})])


def wrong_collateral(ctx):
    # Right, and "Berkeley" relabelled as well.
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's18.w26'})])
    mend(ctx, colon_head=23)
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's19.w1', 'head': 2, 'deprel': 'nsubj:pass'})])


def wrong_nothing(ctx):
    return h.no_plan()
