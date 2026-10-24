import handwrite as h
import umr_hand as u


def right(ctx):
    u.relabel_edge(ctx, 12, 's12c', ':actor', 's12p2', ':undergoer')
    u.relabel_edge(ctx, 12, 's12c', ':undergoer', 's12p', ':actor')


def wrong_half(ctx):
    u.relabel_edge(ctx, 12, 's12c', ':undergoer', 's12p', ':actor')


def wrong_concepts_swapped(ctx):
    # The nodes' concepts traded instead of the roles: the graph reads the
    # same, but the person node is now pe and its words and attributes lie.
    u.set_concept(ctx, 12, 's12p', 'pe')
    u.set_concept(ctx, 12, 's12p2', 'person')


def wrong_nothing(ctx):
    return h.no_plan()
