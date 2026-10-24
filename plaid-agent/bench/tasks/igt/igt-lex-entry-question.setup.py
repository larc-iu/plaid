import common as c
import igtlib as L


def setup(ctx):
    for d in ctx.project['documents']:
        v = c.igt_values(L.raw(ctx, d['name']))
        by = {}
        for k, x in v.items():
            if k.endswith(':form') and str(x).lower() == 'ди':
                by.setdefault(v.get(k[:-5] + ':Gloss'), []).append(k[:-5])
        for g, refs in by.items():
            L.link(ctx, d['name'], refs, f'ди|{g}', verified=False)
    L.snap(ctx)
