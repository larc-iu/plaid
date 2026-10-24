import common as c
import handwrite as h
import igtlib as L


def _fill(ctx, skip_doc=None, value='CN', extra=None):
    for d in ctx.project['documents']:
        if d['name'] == skip_doc:
            continue
        v = c.igt_values(L.raw(ctx, d['name']))
        refs = {k[:-5]: value for k, x in v.items() if k.endswith(':form') and str(x).lower() == 'hl'}
        if extra and d['name'] == 'Gitksan text 1':
            refs.update(extra)
        L.set_field(ctx, d['name'], refs)


def right(ctx):
    _fill(ctx)


def wrong_one_text(ctx):
    _fill(ctx, skip_doc='Gitksan text 3')


def wrong_value(ctx):
    _fill(ctx, value='CN.CONN')


def wrong_collateral(ctx):
    # The connective -t (3.II) glossed too.
    _fill(ctx, extra={'s4.w2.m2': 'CN'})


def wrong_nothing(ctx):
    return h.no_plan()
