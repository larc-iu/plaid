import handwrite as h
import umr_hand as u


def right(ctx):
    u.set_attr(ctx, 13, 's13p', ':modal-strength', 'full-negative')


def wrong_aspect_dropped(ctx):
    u.set_attrs(ctx, 13, 's13p', [(':modal-strength', 'full-negative')])


def wrong_node(ctx):
    u.set_attr(ctx, 14, 's14p', ':modal-strength', 'full-negative')


def wrong_also_polarity(ctx):
    u.set_attr(ctx, 13, 's13p', ':modal-strength', 'full-negative')
    u.set_attr(ctx, 13, 's13p3', ':polarity', '-')


def wrong_nothing(ctx):
    return h.no_plan()
