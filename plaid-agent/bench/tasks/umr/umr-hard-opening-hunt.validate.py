import handwrite as h
import umr_hand as u


def right(ctx):
    u.relabel_edge(ctx, 1, 's1c', ':experiencer', 's1a', ':actor')
    u.set_attr(ctx, 1, 's1c', ':aspect', 'process')


def wrong_aspect_only(ctx):
    u.set_attr(ctx, 1, 's1c', ':aspect', 'process')


def wrong_role_only(ctx):
    u.relabel_edge(ctx, 1, 's1c', ':experiencer', 's1a', ':actor')


def wrong_dropped_quote(ctx):
    # A rewrite of s1 that loses the cycle back to the root.
    right(ctx)
    u.delete_edge(ctx, 1, 's1c', ':quote', 's1x')


def wrong_s3_touched(ctx):
    right(ctx)
    u.set_attr(ctx, 3, 's3c', ':aspect', 'activity')


def wrong_nothing(ctx):
    return h.no_plan()
