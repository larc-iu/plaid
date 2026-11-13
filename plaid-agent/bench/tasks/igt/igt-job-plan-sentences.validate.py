import handwrite
import igt_job_hand as H


def _ended(ctx, documents, **report):
    jid = H.start(ctx, documents)
    ctx.client.jobs.finish(jid, H.WORKER, 'done', {'state': 'done', **report})
    ctx.job = ctx.client.jobs.get(jid)
    return jid

DOCS = ['Lezgi text 1']


def right(ctx):
    _ended(ctx, DOCS, plan={'pieces': 'sentences', 'by': 'model', 'piece_instructions': '', 'documents': None})
    return handwrite.no_plan()


def wrong_other_pieces(ctx):
    _ended(ctx, DOCS, plan={'pieces': 'document', 'by': 'model', 'piece_instructions': '', 'documents': None})
    return handwrite.no_plan()


def wrong_default(ctx):
    """The planning ended with no plan: the job fell back to stretches."""
    _ended(ctx, DOCS, plan={'pieces': 'sentences', 'by': 'default', 'why': 'no-plan', 'documents': None})
    return handwrite.no_plan()


def wrong_no_plan(ctx):
    _ended(ctx, DOCS)
    return handwrite.no_plan()
