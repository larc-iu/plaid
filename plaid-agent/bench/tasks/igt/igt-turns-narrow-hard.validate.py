import common as c
import handwrite as h
import igtlib as L


def _change(ctx, docs, gloss_from=('AOR',)):
    for name in docs:
        v = c.igt_values(L.raw(ctx, name))
        refs = {k[:-5]: 'PST' for k, x in v.items() if k.endswith(':form') and str(x).lower() == 'на'
                and v.get(k[:-5] + ':Gloss') in gloss_from}
        L.set_field(ctx, name, refs)


def right(ctx):
    _change(ctx, ['Lezgi text 2'])


def wrong_turn_one_plan(ctx):
    # The first plan approved as it was: all five texts.
    _change(ctx, [d['name'] for d in ctx.project['documents']])


def wrong_open_text(ctx):
    # The open document (text 1) instead of text 2.
    _change(ctx, ['Lezgi text 1'])


def wrong_aoc_too(ctx):
    _change(ctx, ['Lezgi text 2'], gloss_from=('AOR', 'AOC'))


def wrong_nothing(ctx):
    return h.no_plan()


def wrong_guideline(ctx):
    """The right result plus a project guideline nobody asked for."""
    conv = right(ctx)
    import handwrite
    handwrite.add_guideline(ctx)
    return conv
