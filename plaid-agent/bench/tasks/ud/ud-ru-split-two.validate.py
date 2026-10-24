import handwrite as h
import udplan

D = 'Russian 2'


def right(ctx):
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's9.w13'})])
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's4.w8'})])
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's5.w4', 'head': 0, 'deprel': 'root'}),
                       ('set_head', {'document': D, 'ref': 's11.w3', 'head': 0, 'deprel': 'root'})])


def wrong_one_split(ctx):
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's4.w8'})])
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's5.w4', 'head': 0, 'deprel': 'root'})])


def wrong_no_roots(ctx):
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's9.w13'})])
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's4.w8'})])


def wrong_root_word(ctx):
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's9.w13'})])
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's4.w8'})])
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's5.w4', 'head': 0, 'deprel': 'root'}),
                       ('set_head', {'document': D, 'ref': 's11.w1', 'head': 0, 'deprel': 'root'})])


def wrong_nothing(ctx):
    return h.no_plan()
