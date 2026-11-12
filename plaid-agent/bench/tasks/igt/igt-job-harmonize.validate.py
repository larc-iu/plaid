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


def _harmonize(ctx, jid, name, address, morphs):
    """A word rewritten as the job's harmonize pass writes: its History entry."""
    did = next(d['id'] for d in ctx.project['documents'] if d['name'] == name)
    with ctx.user.operation('Assistant job: analyses made consistent', kind='job',
                            ref=f'job:{jid}/doc:{did}/pass:harmonize'):
        H.analyze(ctx, name, address, morphs, H.job_stamp(jid))


def right_consistent_other_analysis(ctx):
    """The job analysed every я one way, not the people's: harmonize touches
    only a form the job analysed in two or more ways (SPEC 8.2)."""
    jid = H.start(ctx, DOCS)
    for name in DOCS:
        for a, _ in H.words(ctx, name, form='я'):
            H.analyze(ctx, name, a, [('я', 'COP')], H.job_stamp(jid))
    H.finish(ctx, jid)
    return handwrite.no_plan()


def wrong_two_ways_left(ctx):
    """The job analysed я two ways and harmonize did nothing."""
    jid = H.start(ctx, DOCS)
    first = True
    for name in DOCS:
        for a, _ in H.words(ctx, name, form='я'):
            H.analyze(ctx, name, a, [('я', 'COP')] if first else _people(ctx), H.job_stamp(jid))
            first = False
    H.finish(ctx, jid)
    return handwrite.no_plan()


def wrong_majority_over_the_person(ctx):
    """The job analysed я two ways, and harmonize set them all to its own
    majority where a person's one analysis wins."""
    jid = H.start(ctx, DOCS)
    people = _people(ctx)
    words = [(name, a) for name in DOCS for a, _ in H.words(ctx, name, form='я')]
    for i, (name, a) in enumerate(words):
        H.analyze(ctx, name, a, people if i == 0 else [('я', 'COP')], H.job_stamp(jid))
    name, a = words[0]
    _harmonize(ctx, jid, name, a, [('я', 'COP')])
    H.finish(ctx, jid)
    return handwrite.no_plan()


def wrong_harmonize_over_a_persons_work(ctx):
    """REV-J-B S1-1: a person redid a word the job analysed (as people
    analyse я elsewhere, so people still analyse it one way), and harmonize
    wrote over the person's work in the job's name."""
    jid = H.start(ctx, DOCS)
    people = _people(ctx)
    words = [(name, a) for name in DOCS for a, _ in H.words(ctx, name, form='я')]
    for name, a in words:
        H.analyze(ctx, name, a, people, H.job_stamp(jid))
    name, a = words[-1]
    H.analyze(ctx, name, a, people, {'note': 'redone by hand'})
    _harmonize(ctx, jid, name, a, people)
    H.finish(ctx, jid)
    return handwrite.no_plan()


def wrong_untouched(ctx):
    jid = H.start(ctx, DOCS)
    H.finish(ctx, jid)
    return handwrite.no_plan()
