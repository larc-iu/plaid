import handwrite as h
import udplan

D = 'Arabic 1'


def right(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's1.w8', 'head': 7, 'deprel': 'nmod'})])


def wrong_reversed(ctx):
    # The words swapped: حياة under متشرد.
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's1.w8', 'head': 6, 'deprel': 'obj'}),
                       ('set_head', {'document': D, 'ref': 's1.w7', 'head': 8, 'deprel': 'nmod'})])


def wrong_deprel(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's1.w8', 'head': 7, 'deprel': 'amod'})])


def wrong_nothing(ctx):
    return h.no_plan()
