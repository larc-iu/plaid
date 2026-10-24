import common as c
import handwrite as h
import igtlib as L


def _relink(ctx, skip_doc=None, only_aor=False):
    for d in ctx.project['documents']:
        if d['name'] == skip_doc:
            continue
        raw = L.raw(ctx, d['name'])
        v = c.igt_values(raw)
        refs = [k[:-5] for k, x in v.items() if k.endswith(':form') and str(x).lower() == 'на']
        L.unlink(ctx, d['name'], refs)
        by = {}
        for r in refs:
            g = v.get(r + ':Gloss')
            by.setdefault('AOR' if only_aor else g, []).append(r)
        for g, rs in by.items():
            L.link(ctx, d['name'], rs, f'на|{g}')


def right(ctx):
    _relink(ctx)


def wrong_one_document_left(ctx):
    _relink(ctx, skip_doc='Lezgi text 5')


def wrong_all_aor(ctx):
    _relink(ctx, only_aor=True)


def wrong_collateral(ctx):
    _relink(ctx)
    L.link(ctx, 'Lezgi text 1', ['s1.w2.m1'], 'зун|1sg.abs')


def wrong_nothing(ctx):
    return h.no_plan()
