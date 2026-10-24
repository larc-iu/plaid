import common as c
import handwrite as h
import igtlib as L


def _by_gloss(ctx):
    out = []
    for d in ctx.project['documents']:
        v = c.igt_values(L.raw(ctx, d['name']))
        for k, x in v.items():
            if k.endswith(':form') and str(x).lower() == 'ka':
                out.append((d['name'], k[:-5], v.get(k[:-5] + ':Gloss')))
    return out


def _relink(ctx, target_of):
    for doc, a, g in _by_gloss(ctx):
        t = target_of(g)
        if t:
            L.unlink(ctx, doc, [a])
            L.link(ctx, doc, [a], t)


def right(ctx):
    _relink(ctx, lambda g: {'not.yet': 'ka|not.yet', 'give': 'ka|give'}.get(g))


def wrong_swapped(ctx):
    # The two homographs mixed up.
    _relink(ctx, lambda g: {'not.yet': 'ka|give', 'give': 'ka|not.yet'}.get(g))


def wrong_not_yet_only(ctx):
    _relink(ctx, lambda g: {'not.yet': 'ka|not.yet'}.get(g))


def wrong_relinked_demonstratives(ctx):
    # Right, and the demonstratives relinked to the headword ka (collateral).
    right(ctx)
    _relink(ctx, lambda g: 'ka|' if g == 'DEM2.PROΧ' else None)


def wrong_unlinked(ctx):
    # The wrong links removed, nothing linked in their place.
    for doc, a, g in _by_gloss(ctx):
        if g in ('not.yet', 'give'):
            L.unlink(ctx, doc, [a])


def wrong_nothing(ctx):
    return h.no_plan()


def wrong_collateral(ctx):
    # Right, and the not-yet headword's gloss rewritten unasked.
    right(ctx)
    L.patch_entry(ctx, 'ka|not.yet', {'gloss': 'not yet'})
