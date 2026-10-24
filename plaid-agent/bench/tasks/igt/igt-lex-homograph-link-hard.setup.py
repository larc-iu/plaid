import common as c
import igtlib as L


def ka_refs(ctx, name):
    v = c.igt_values(L.raw(ctx, name))
    return [k[:-5] for k, x in v.items() if k.endswith(':form') and str(x).lower() == 'ka']


def setup(ctx):
    # Two senses of ka freed as homograph headwords of their own.
    L.patch_entry(ctx, 'ka|', {'homograph': 1})
    L.patch_entry(ctx, 'ka|give', {'parent': None, 'senseOrder': None, 'homograph': 2})
    L.patch_entry(ctx, 'ka|not.yet', {'parent': None, 'senseOrder': None, 'homograph': 3})
    for d in ctx.project['documents']:
        L.link(ctx, d['name'], ka_refs(ctx, d['name']), 'ka|DEM2.PROΧ', verified=False)
    L.snap(ctx)
