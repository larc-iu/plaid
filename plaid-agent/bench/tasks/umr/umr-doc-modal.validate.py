import handwrite as h
import umr_hand as u


def right(ctx):
    u.add_triple(ctx, 'root', ':modal', 'author', 'modal')
    u.add_triple(ctx, 'author', ':full-affirmative', 's7.s7r', 'modal')
    u.add_triple(ctx, 'author', ':full-negative', 's13.s13p', 'modal')


def wrong_partial_strength(ctx):
    u.add_triple(ctx, 'author', ':partial-affirmative', 's7.s7r', 'modal')
    u.add_triple(ctx, 'author', ':full-negative', 's13.s13p', 'modal')


def wrong_reversed(ctx):
    u.add_triple(ctx, 's7.s7r', ':full-affirmative', 'author', 'modal')
    u.add_triple(ctx, 's13.s13p', ':full-negative', 'author', 'modal')


def wrong_attribute_too(ctx):
    right(ctx)
    u.set_attr(ctx, 7, 's7r', ':modal-strength', 'partial-affirmative')


def wrong_nothing(ctx):
    return h.no_plan()
