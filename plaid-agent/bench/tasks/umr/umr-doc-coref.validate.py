import handwrite as h
import umr_hand as u


def right(ctx):
    u.add_triple(ctx, 's7.s7a', ':same-entity', 's11.s11a', 'coref')


def wrong_same_event(ctx):
    u.add_triple(ctx, 's7.s7a', ':same-event', 's11.s11a', 'coref')


def wrong_extra_chain(ctx):
    right(ctx)
    u.add_triple(ctx, 's6.s6a', ':same-entity', 's7.s7a', 'coref')


def wrong_wrong_node(ctx):
    u.add_triple(ctx, 's7.s7r', ':same-entity', 's11.s11a', 'coref')


def wrong_nothing(ctx):
    return h.no_plan()
