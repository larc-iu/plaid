import handwrite
import igt_job_hand as H


def _ended(ctx, documents, **report):
    jid = H.start(ctx, documents)
    ctx.client.jobs.finish(jid, H.WORKER, 'done', {'state': 'done', **report})
    ctx.job = ctx.client.jobs.get(jid)
    return jid

DOC = 'Lezgi text 4'


def _table(rows):
    return [{'title': 'Forms glossed more than one way', 'columns': ['form', 'gloss', 'count'], 'rows': rows,
             'more': 0}]


def right(ctx):
    _ended(ctx, [DOC], tables=_table([['я', 'COP', 1], ['я', 'was', 1]]))
    return handwrite.no_plan()


def wrong_one_gloss(ctx):
    _ended(ctx, [DOC], tables=_table([['я', 'COP', 2]]))
    return handwrite.no_plan()


def wrong_prose_only(ctx):
    """The finding in the prose, no table: numbers must come from code."""
    _ended(ctx, [DOC], summary='я is glossed COP once and was once.', tables=[])
    return handwrite.no_plan()


def wrong_other_form(ctx):
    _ended(ctx, [DOC], tables=_table([['ва', 'COP', 1], ['ва', 'was', 1]]))
    return handwrite.no_plan()


def wrong_changed_a_text(ctx):
    """Right otherwise, and a word of Lezgi text 4 glossed: the instructions said
    to change nothing."""
    jid = _ended(ctx, [DOC], tables=_table([['я', 'COP', 1], ['я', 'was', 1]]))
    a = next(w for w, s in H.words(ctx, 'Lezgi text 4') if s.isalpha())
    H.gloss(ctx, jid, 'Lezgi text 4', a, [('x', 'X')])
    return handwrite.no_plan()
