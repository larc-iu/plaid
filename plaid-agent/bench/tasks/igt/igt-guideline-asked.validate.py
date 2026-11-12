import common as c
import handwrite as h
import igtlib as L


def _fill(ctx, value='CN'):
    for d in ctx.project['documents']:
        v = c.igt_values(L.raw(ctx, d['name']))
        L.set_field(ctx, d['name'], {k[:-5]: value for k, x in v.items()
                                     if k.endswith(':form') and str(x).lower() == 'hl'})


def right(ctx):
    _fill(ctx)
    h.add_guideline(ctx, 'The connective hl', 'The common noun connective hl is always glossed CN.')


def wrong_no_guideline(ctx):
    _fill(ctx)


def wrong_guideline_only(ctx):
    h.add_guideline(ctx, 'The connective hl', 'The common noun connective hl is always glossed CN.')


def wrong_guideline_about_something_else(ctx):
    _fill(ctx)
    h.add_guideline(ctx, 'Translations', 'Translations are idiomatic English.')


def wrong_two_guidelines(ctx):
    right(ctx)
    h.add_guideline(ctx, 'Imperfective', 'yukw is glossed IPFV.')


def wrong_nothing(ctx):
    return h.no_plan()
