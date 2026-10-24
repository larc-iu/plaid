import umr_hand as u


def right(ctx):
    return u.answer('15 nodes have the concept ikian.')


def wrong_count(ctx):
    return u.answer('14 nodes have the concept ikian.')


def wrong_wrote(ctx):
    u.set_attr(ctx, 1, 's1i2', ':refer-number', 'singular')
    return u.answer('15.')


def wrong_guideline(ctx):
    """The right result plus a project guideline nobody asked for."""
    conv = right(ctx)
    import handwrite
    handwrite.add_guideline(ctx)
    return conv
