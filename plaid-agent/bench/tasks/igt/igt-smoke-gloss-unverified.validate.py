import handwrite as h


def right(ctx):
    h.set_span(ctx, 'Lezgi text 1', 's2.w3.m1:Gloss', 'COP', unverified=True)


def wrong_verified(ctx):
    """Written as Approve as verified writes it: the wrong button."""
    h.set_span(ctx, 'Lezgi text 1', 's2.w3.m1:Gloss', 'COP')


def wrong_unstamped(ctx):
    h.set_span(ctx, 'Lezgi text 1', 's2.w3.m1:Gloss', 'COP', verified=False)


def wrong_value(ctx):
    h.set_span(ctx, 'Lezgi text 1', 's2.w3.m1:Gloss', 'cop', unverified=True)


def wrong_collateral(ctx):
    h.set_span(ctx, 'Lezgi text 1', 's2.w3.m1:Gloss', 'COP', unverified=True)
    h.set_span(ctx, 'Lezgi text 1', 's2.w2.m1:Gloss', 'two', unverified=True)


def wrong_nothing(ctx):
    return h.no_plan()
