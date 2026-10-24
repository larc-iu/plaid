import common as c
import igtlib as L


def na_refs(ctx, name):
    v = c.igt_values(L.raw(ctx, name))
    return [k[:-5] for k, x in v.items() if k.endswith(':form') and str(x).lower() == 'на']


def setup(ctx):
    for d in ctx.project['documents']:
        L.link(ctx, d['name'], na_refs(ctx, d['name']), 'на|', verified=False)
    L.snap(ctx)
