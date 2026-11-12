import handwrite
import igt_job_hand as H

DOCS = ['Lezgi text 1', 'Lezgi text 2']


def _people(ctx):
    """The one analysis people left of я, as (form, gloss) pairs."""
    import igtlib as L
    for d in ctx.project['documents']:
        if d['name'] in DOCS:
            continue
        values = L.values_now(ctx, d['name'])
        for a, surface in H.words(ctx, d['name'], form='я'):
            ms = sorted(k for k in values if k.startswith(a + '.m') and k.endswith(':form'))
            if ms:
                return [(values[m], values.get(m[:-len(':form')] + ':Gloss')) for m in ms]
    raise AssertionError('no analysis of я by people')


def right(ctx):
    jid = H.start(ctx, DOCS)
    people = _people(ctx)
    for name in DOCS:
        for a, _ in H.words(ctx, name, form='я'):
            H.analyze(ctx, name, a, people, H.job_stamp(jid))
    H.finish(ctx, jid)
    return handwrite.no_plan()


def wrong_majority_over_the_person(ctx):
    """The job's own majority kept where a person analysed the form."""
    jid = H.start(ctx, DOCS)
    for name in DOCS:
        for a, _ in H.words(ctx, name, form='я'):
            H.analyze(ctx, name, a, [('я', 'COP')], H.job_stamp(jid))
    H.finish(ctx, jid)
    return handwrite.no_plan()


def wrong_untouched(ctx):
    jid = H.start(ctx, DOCS)
    H.finish(ctx, jid)
    return handwrite.no_plan()
