import handwrite
import igt_job_hand as H
import igtlib as L

DOC = 'Lezgi text 4'


def _ended(ctx, write=None, **report):
    """A job over the text: ``write(jid, address)`` writes at the second я
    (the imported "was"), then the job ends with ``report``."""
    jid = H.start(ctx, [DOC], 'Gloss every я in Lezgi text 4 as COP.')
    a = [w for w, _ in H.words(ctx, DOC, form='я')][-1]
    if write:
        write(jid, a)
    ctx.client.jobs.finish(jid, H.WORKER, 'done', {'state': 'done', **report})
    ctx.job = ctx.client.jobs.get(jid)
    return handwrite.no_plan()


def right(ctx):
    return _ended(ctx, lambda jid, a: H.gloss(ctx, jid, DOC, a, [('я', 'COP')]), proposed=[], proposed_more=0)


def wrong_only_proposed(ctx):
    """The withdrawn rule's outcome: proposed, nothing written."""
    did = L.doc_of(ctx, DOC)['id']
    return _ended(ctx, proposed=[{'kind': 'set_span', 'document_id': did, 'document': DOC, 'ref': 's1.w1.m1',
                                  'field': 'Gloss', 'from': 'was', 'to': 'COP', 'label': 'x', 'note': ''}])


def wrong_written_as_a_persons(ctx):
    """COP written with no provenance: a job's value is a machine proposal."""
    return _ended(ctx, lambda jid, a: H.analyze(ctx, DOC, a, [('я', 'COP')], {'by': 'hand'}))


def wrong_other_value(ctx):
    return _ended(ctx, lambda jid, a: H.gloss(ctx, jid, DOC, a, [('я', 'be')]))


def wrong_another_word_changed(ctx):
    """The person's COP analysed again otherwise: not asked."""
    def write(jid, a):
        H.gloss(ctx, jid, DOC, a, [('я', 'COP')])
        first = [w for w, _ in H.words(ctx, DOC, form='я')][0]
        H.gloss(ctx, jid, DOC, first, [('я', 'be')])
    return _ended(ctx, write)
