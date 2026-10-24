import handwrite as h
import igtlib as L

M = [('silin', 'hunt'), ('asxw', 'ANTIP'), ('t', '3.II')]


def _merge(ctx):
    ids = L.ids_by_address(L.raw(ctx, 'Gitksan text 1'))
    ctx.user.tokens.merge(ids['s4.w9'], ids['s4.w10'])


def right(ctx):
    _merge(ctx)
    L.analyze(ctx, 'Gitksan text 1', 's4.w9', M)
    return h.applied_plan()


def wrong_merge_only(ctx):
    _merge(ctx)


def wrong_no_merge(ctx):
    # The first half analyzed as the whole word, the split left.
    L.analyze(ctx, 'Gitksan text 1', 's4.w9', M)


def wrong_collateral(ctx):
    right(ctx)
    L.set_field(ctx, 'Gitksan text 1', {'s4.w8.m1': 'IPFV.CONT'})


def wrong_nothing(ctx):
    return h.no_plan()


def right_with_links(ctx):
    """Not run by validate (only right and wrong_*), kept for checking the
    optional links by hand."""
    conv = right(ctx)
    d = 'Gitksan text 1'
    for i, lab in enumerate(['silin|hunt', 'asxw|ANTIP', 't|3.II'], 1):
        L.link(ctx, d, [f's4.w9.m{i}'], lab)
    return conv


def wrong_link_other_sense(ctx):
    """The right result, its new morphemes linked, the suffix t to the 3.I sense."""
    conv = right(ctx)
    d = 'Gitksan text 1'
    for i, lab in enumerate(['silin|hunt', 'asxw|ANTIP', 't|3.I'], 1):
        L.link(ctx, d, [f's4.w9.m{i}'], lab)
    return conv
