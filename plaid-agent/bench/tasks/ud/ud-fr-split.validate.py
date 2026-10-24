import handwrite as h
import udplan

D = 'French 2'


def mend(ctx, dots_head=4):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's14.w4', 'head': 0, 'deprel': 'root'}),
                       ('set_head', {'document': D, 'ref': 's14.w11', 'head': 4, 'deprel': 'punct'}),
                       ('set_head', {'document': D, 'ref': 's13.w12', 'head': dots_head, 'deprel': 'punct'})])


def right(ctx):
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's13.w13'})])
    mend(ctx)


def wrong_split_only(ctx):
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's13.w13'})])


def wrong_boundary(ctx):
    # One word late: "Les" stays in sentence 13.
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's13.w14'})])
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's14.w3', 'head': 0, 'deprel': 'root'})])


def wrong_dots(ctx):
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's13.w13'})])
    mend(ctx, dots_head=11)


def wrong_nothing(ctx):
    return h.no_plan()
