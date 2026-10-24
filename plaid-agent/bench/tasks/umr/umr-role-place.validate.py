import handwrite as h
import umr_hand as u


def right(ctx):
    u.relabel_edge(ctx, 7, 's7r', ':temporal', 's7r2', ':place')


def wrong_both_roles(ctx):
    u.add_edge(ctx, 7, 's7r', ':place', 's7r2')


def wrong_alignment_lost(ctx):
    # The node deleted and made again under the same variable: right roles,
    # but it no longer covers raepe.
    d = u.Doc(ctx)
    ctx.user.tokens.bulk_delete(d.node(7, 's7r2')['span']['tokens'])
    u.create_node(ctx, 7, 's7r2', 'raepe')
    u.add_edge(ctx, 7, 's7r', ':place', 's7r2')


def wrong_role(ctx):
    u.relabel_edge(ctx, 7, 's7r', ':temporal', 's7r2', ':source')


def wrong_nothing(ctx):
    return h.no_plan()


def wrong_guideline(ctx):
    """The right result plus a project guideline nobody asked for."""
    conv = right(ctx)
    import handwrite
    handwrite.add_guideline(ctx)
    return conv
