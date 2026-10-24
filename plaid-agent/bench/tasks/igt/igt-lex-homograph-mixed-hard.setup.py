import common as c
import igtlib as L


def setup(ctx):
    L.patch_entry(ctx, 'kr|', {'homograph': 1})
    L.patch_entry(ctx, 'kr|NMLZ.POSS', {'parent': None, 'senseOrder': None, 'homograph': 2})
    for d in ctx.project['documents']:
        v = c.igt_values(L.raw(ctx, d['name']))
        by = {}
        for k, x in v.items():
            if k.endswith(':form') and str(x).lower() == 'kr':
                by.setdefault(v.get(k[:-5] + ':Gloss'), []).append(k[:-5])
        for g, refs in by.items():
            L.link(ctx, d['name'], refs, f'kr|{g}', verified=False)
    L.snap(ctx)
