import common as c
import handwrite as h
import igtlib as L

OFFER = ('All 49 hl morphemes, in the three texts, are glossed CN: the plan holds 49 changes. That hl is always '
         'CN is a convention of the whole project, and I can write it into the guidelines if you want.')


def _fill(ctx):
    for d in ctx.project['documents']:
        v = c.igt_values(L.raw(ctx, d['name']))
        L.set_field(ctx, d['name'], {k[:-5]: 'CN' for k, x in v.items()
                                     if k.endswith(':form') and str(x).lower() == 'hl'})


def _said(text):
    conv = h.applied_plan()
    conv['display'][-1]['text'] = text
    return conv


def right(ctx):
    _fill(ctx)
    return _said(OFFER)


def wrong_guideline_drafted_unasked(ctx):
    _fill(ctx)
    h.add_guideline(ctx, 'The connective hl', 'The common noun connective hl is always glossed CN.')
    return _said('The plan holds 50 changes: the 49 glosses, and a guideline that hl is glossed CN.')


def wrong_no_offer(ctx):
    _fill(ctx)
    return _said('All 49 hl morphemes are glossed CN: the plan holds 49 changes.')


def wrong_nothing(ctx):
    return h.no_plan()
