import handwrite as h


def right(ctx):
    h.set_span(ctx, 'Lezgi text 1', 's2.w3.m1:Gloss', 'COP')


def wrong_value(ctx):
    h.set_span(ctx, 'Lezgi text 1', 's2.w3.m1:Gloss', 'cop')


def wrong_collateral(ctx):
    h.set_span(ctx, 'Lezgi text 1', 's2.w3.m1:Gloss', 'COP')
    h.set_span(ctx, 'Lezgi text 1', 's2.w2.m1:Gloss', 'two')


def wrong_unstamped(ctx):
    h.set_span(ctx, 'Lezgi text 1', 's2.w3.m1:Gloss', 'COP', verified=False)


def wrong_nothing(ctx):
    return h.no_plan()


def wrong_guideline(ctx):
    """The right result plus a project guideline nobody asked for."""
    conv = right(ctx)
    import handwrite
    handwrite.add_guideline(ctx)
    return conv
