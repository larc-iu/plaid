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
            H.gloss(ctx, jid, name, a, people)
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
            H.gloss(ctx, jid, name, a, [('я', 'COP')])
    H.finish(ctx, jid)
    return handwrite.no_plan()


def wrong_two_ways_left(ctx):
    """The job analysed я two ways and harmonize did nothing."""
    jid = H.start(ctx, DOCS)
    first = True
    for name in DOCS:
        for a, _ in H.words(ctx, name, form='я'):
            H.gloss(ctx, jid, name, a, [('я', 'COP')] if first else _people(ctx))
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
        H.gloss(ctx, jid, name, a, people if i == 0 else [('я', 'COP')])
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
        H.gloss(ctx, jid, name, a, people)
    name, a = words[-1]
    H.analyze(ctx, name, a, people, {'note': 'redone by hand'})
    _harmonize(ctx, jid, name, a, people)
    H.finish(ctx, jid)
    return handwrite.no_plan()


def wrong_untouched(ctx):
    jid = H.start(ctx, DOCS)
    H.finish(ctx, jid)
    return handwrite.no_plan()


def _words(ctx):
    words = [(name, a) for name in DOCS for a, _ in H.words(ctx, name, form='я')]
    assert len(words) >= 3, 'the task wants three я or more in the job\'s documents'
    return words


def right_harmonized(ctx):
    """The job analysed я two ways, and harmonize set the job's other words
    to the people's one analysis, in History entries of its own."""
    jid = H.start(ctx, DOCS)
    people = _people(ctx)
    words = _words(ctx)
    for i, (name, a) in enumerate(words):
        H.gloss(ctx, jid, name, a, [('я', 'COP')] if i == 0 else people)
    name, a = words[0]
    _harmonize(ctx, jid, name, a, people)
    H.finish(ctx, jid)
    return handwrite.no_plan()


def right_leaves_a_form_people_analyse_two_ways_by_then(ctx):
    """While the job ran, a person analysed one of the job's я their own way
    (COP): people analyse я two ways when harmonize begins, and harmonize
    leaves the form (SPEC 8.2, people-differ)."""
    jid = H.start(ctx, DOCS)
    people = _people(ctx)
    words = _words(ctx)
    for i, (name, a) in enumerate(words):
        H.gloss(ctx, jid, name, a, [('я', 'COP')] if i < 2 else people)
    name, a = words[0]
    H.analyze(ctx, name, a, [('я', 'COP')], {'note': 'by hand'})
    H.finish(ctx, jid)
    return handwrite.no_plan()


def wrong_harmonize_by_people_as_they_were(ctx):
    """REV-J-B2 S2-1: while the job ran, a person analysed one of the job's
    я their own way (COP), so people analyse я two ways when harmonize
    begins and it must leave the form. Harmonize voted with people's
    analyses as they were before the job and set the job's other COP to the
    first people's analysis."""
    jid = H.start(ctx, DOCS)
    people = _people(ctx)
    words = _words(ctx)
    for i, (name, a) in enumerate(words):
        H.gloss(ctx, jid, name, a, [('я', 'COP')] if i < 2 else people)
    name, a = words[0]
    H.analyze(ctx, name, a, [('я', 'COP')], {'note': 'by hand'})
    name, a = words[1]
    _harmonize(ctx, jid, name, a, people)
    H.finish(ctx, jid)
    return handwrite.no_plan()


def wrong_harmonize_puts_back_a_deletion(ctx):
    """REV-J-B2 S3-1: a person cleared the gloss of one of the job's
    morphemes on a word, and harmonize rewrote the word in the job's name."""
    import common as c
    import igtlib as L
    jid = H.start(ctx, DOCS)
    people = _people(ctx)
    words = _words(ctx)
    for i, (name, a) in enumerate(words):
        H.gloss(ctx, jid, name, a, [('я', 'COP'), ('я', 'PTCL')] if i == 0 else people)
    name, a = words[0]
    span = c.igt_spans(L.raw(ctx, name))[f'{a}.m2:Gloss']
    ctx.user.spans.delete(span['id'])
    _harmonize(ctx, jid, name, a, people)
    H.finish(ctx, jid)
    return handwrite.no_plan()


def wrong_harmonize_over_a_comment(ctx):
    """REV-J-B2 S4: a person commented on one of the job's words, and
    harmonize rewrote it under the comment."""
    import igtlib as L
    jid = H.start(ctx, DOCS)
    people = _people(ctx)
    words = _words(ctx)
    for i, (name, a) in enumerate(words):
        H.gloss(ctx, jid, name, a, [('я', 'COP')] if i == 0 else people)
    name, a = words[0]
    ctx.user.comments.create('token', L.ids_by_address(L.raw(ctx, name))[a], 'Is this right?')
    _harmonize(ctx, jid, name, a, people)
    H.finish(ctx, jid)
    return handwrite.no_plan()
