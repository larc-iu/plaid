import handwrite as h


def right(ctx):
    h.set_umr_attr(ctx, 'Kukama text 2', 's1x', ':modal-strength', 'partial-affirmative')


def wrong_node(ctx):
    h.set_umr_attr(ctx, 'Kukama text 2', 's1u', ':modal-strength', 'partial-affirmative')


def wrong_value(ctx):
    h.set_umr_attr(ctx, 'Kukama text 2', 's1x', ':modal-strength', 'neutral-affirmative')


def wrong_nothing(ctx):
    return h.no_plan()
