import common as c
import igtlib as L


def setup(ctx):
    for d in ctx.project['documents']:
        v = c.igt_values(L.raw(ctx, d['name']))
        refs = [k[:-5] for k, x in v.items() if k.endswith(':form') and str(x).lower() == 'mz']
        L.link(ctx, d['name'], refs, 'mz|PREP', verified=False)
    L.snap(ctx)
