import handwrite as h
import umr_hand as u


def right(ctx):
    for s, var in ((1, 's1x2'), (4, 's4x'), (15, 's15x')):
        u.set_attr(ctx, s, var, ':refer-number', 'singular')


def wrong_partial(ctx):
    u.set_attr(ctx, 1, 's1x2', ':refer-number', 'singular')


def wrong_other_concept(ctx):
    right(ctx)
    u.set_attr(ctx, 1, 's1x', ':refer-number', 'singular')


def wrong_restamps_the_rest(ctx):
    right(ctx)
    u.set_attr(ctx, 19, 's19x', ':refer-number', 'singular')


def wrong_nothing(ctx):
    return h.no_plan()
