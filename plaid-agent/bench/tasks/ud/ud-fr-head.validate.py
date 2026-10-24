import handwrite as h
import udplan

D = 'French 3'


def right(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's11.w13', 'head': 8, 'deprel': 'obl:mod'})])


def wrong_head(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's11.w13', 'head': 7, 'deprel': 'obl:mod'})])


def wrong_deprel(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's11.w13', 'head': 8, 'deprel': 'obl'})])


def wrong_collateral(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's11.w13', 'head': 8, 'deprel': 'obl:mod'}),
                       ('set_head', {'document': D, 'ref': 's11.w10', 'head': 8, 'deprel': 'obj'})])


def wrong_nothing(ctx):
    return h.no_plan()


def wrong_guideline(ctx):
    """The right result plus a project guideline nobody asked for."""
    conv = right(ctx)
    import handwrite
    handwrite.add_guideline(ctx)
    return conv
