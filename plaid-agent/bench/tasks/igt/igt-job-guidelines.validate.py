import handwrite
import igt_job_hand as H

DOC = 'Lezgi text 4'
CHANGE = {'kind': 'add_guideline', 'document_id': None, 'document': None, 'ref': None, 'field': None,
          'from': None, 'to': None, 'label': 'add guideline "я"', 'note': 'Proposed the guideline.'}


def _ended(ctx, **report):
    jid = H.start(ctx, [DOC], 'Add a guideline saying that я is glossed COP.')
    ctx.client.jobs.finish(jid, H.WORKER, 'done', {'state': 'done', **report})
    ctx.job = ctx.client.jobs.get(jid)
    return jid


def right(ctx):
    _ended(ctx, proposed=[CHANGE], proposed_more=0)
    return handwrite.no_plan()


def wrong_written(ctx):
    """The guideline written: project setup is a person's."""
    _ended(ctx, proposed=[], proposed_more=0)
    handwrite.add_guideline(ctx, 'я', 'я is glossed COP.')
    return handwrite.no_plan()


def wrong_not_listed(ctx):
    _ended(ctx, proposed=[], proposed_more=0)
    return handwrite.no_plan()


def wrong_text_changed(ctx):
    """The text glossed as well: the instructions said to change nothing."""
    jid = _ended(ctx, proposed=[CHANGE], proposed_more=0)
    a = [w for w, _ in H.words(ctx, DOC, form='я')][-1]
    H.gloss(ctx, jid, DOC, a, [('я', 'COP')])
    return handwrite.no_plan()
