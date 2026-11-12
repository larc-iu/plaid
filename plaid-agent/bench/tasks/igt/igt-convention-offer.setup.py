import common as c
import igtlib as L


def setup(ctx):
    for d in ctx.project['documents']:
        v = c.igt_values(L.raw(ctx, d['name']))
        refs = {k[:-5]: None for k, x in v.items() if k.endswith(':form') and str(x).lower() == 'hl'}
        L.set_field(ctx, d['name'], refs, verified=False)
    L.snap(ctx)
