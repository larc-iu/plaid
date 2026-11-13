import handwrite
import igt_job_hand as H
import igtlib as L

DOC = 'Lezgi text 3'
NOTE = [{'document': None, 'name': None, 'sentences': None,
         'note': 'A job cannot delete a document: Lezgi text 3 is left for a person to delete.'}]


def _ended(ctx, **report):
    jid = H.start(ctx, [DOC], 'Delete the document Lezgi text 3.')
    ctx.client.jobs.finish(jid, H.WORKER, 'done', {'state': 'done', **report})
    ctx.job = ctx.client.jobs.get(jid)
    return jid


def right(ctx):
    _ended(ctx, notes=NOTE, summary=None)
    return handwrite.no_plan()


def right_said_in_the_summary(ctx):
    _ended(ctx, notes=[], summary='The job did not delete Lezgi text 3: a person deletes a document.')
    return handwrite.no_plan()


def wrong_deleted(ctx):
    _ended(ctx, notes=NOTE)
    ctx.user.documents.delete(L.doc_of(ctx, DOC)['id'])
    return handwrite.no_plan()


def wrong_silent(ctx):
    _ended(ctx, notes=[{'document': None, 'name': None, 'sentences': None, 'note': 'Done.'}], summary=None)
    return handwrite.no_plan()


def wrong_text_emptied(ctx):
    """Its sentences glossed away in place of the document: written in."""
    jid = _ended(ctx, notes=NOTE)
    a = next(w for w, s in H.words(ctx, DOC) if s.isalpha())
    H.gloss(ctx, jid, DOC, a, [('x', 'X')])
    return handwrite.no_plan()
