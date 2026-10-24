import handwrite as h
import umr_hand as u


def right(ctx):
    for s, var in ((4, 's4p'), (5, 's5p'), (13, 's13p')):
        u.set_attr(ctx, s, var, ':aspect', 'performance')


def wrong_overwrites_s14(ctx):
    right(ctx)
    u.set_attr(ctx, 14, 's14p', ':aspect', 'performance')


def wrong_partial(ctx):
    for s, var in ((4, 's4p'), (5, 's5p')):
        u.set_attr(ctx, s, var, ':aspect', 'performance')


def wrong_value(ctx):
    for s, var in ((4, 's4p'), (5, 's5p'), (13, 's13p')):
        u.set_attr(ctx, s, var, ':aspect', 'activity')
