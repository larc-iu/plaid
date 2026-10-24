import handwrite as h
import udplan

D = 'French 1'


def right(ctx):
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's2.w15'})])
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's3.w3', 'head': 0, 'deprel': 'root'})])


def wrong_lowercase_mais(ctx):
    # Split at the coordinating "mais" inside the first sentence.
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's2.w6'})])
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's3.w4', 'head': 0, 'deprel': 'root'})])


def wrong_split_only(ctx):
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's2.w15'})])


def wrong_collateral(ctx):
    # Right, and the question mark moved under "contexte".
    udplan.apply(ctx, [('split_sentence', {'document': D, 'ref': 's2.w15'})])
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's3.w3', 'head': 0, 'deprel': 'root'}),
                       ('set_head', {'document': D, 'ref': 's3.w9', 'head': 6, 'deprel': 'punct'})])


def wrong_nothing(ctx):
    return h.no_plan()
