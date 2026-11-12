import handwrite
import igt_job_hand as H

DOC = 'Lezgi text 1'


def _blank(ctx):
    return H.words(ctx, DOC, sentences=range(1, 6))


def right(ctx):
    jid = H.start(ctx, [DOC])
    for a, surface in _blank(ctx)[:-2]:
        H.analyze(ctx, DOC, a, [(surface.lower(), 'x')], H.job_stamp(jid))
    H.finish(ctx, jid)
    return handwrite.no_plan()


def wrong_verified(ctx):
    """Written as an approved plan writes, not as a job's proposal."""
    jid = H.start(ctx, [DOC])
    for a, surface in _blank(ctx):
        H.analyze(ctx, DOC, a, [(surface.lower(), 'x')], handwrite.stamp('igt'))
    H.finish(ctx, jid)
    return handwrite.no_plan()


def wrong_protected(ctx):
    """A word a person analysed, in sentence 6, rewritten by the job."""
    jid = H.start(ctx, [DOC])
    for a, surface in _blank(ctx):
        H.analyze(ctx, DOC, a, [(surface.lower(), 'x')], H.job_stamp(jid))
    a, surface = H.words(ctx, DOC, sentences=[6])[0]
    H.analyze(ctx, DOC, a, [(surface.lower(), 'x')], H.job_stamp(jid))
    H.finish(ctx, jid)
    return handwrite.no_plan()


def wrong_nothing(ctx):
    jid = H.start(ctx, [DOC])
    H.finish(ctx, jid)
    return handwrite.no_plan()


def wrong_cancelled(ctx):
    jid = H.start(ctx, [DOC])
    for a, surface in _blank(ctx):
        H.analyze(ctx, DOC, a, [(surface.lower(), 'x')], H.job_stamp(jid))
    ctx.user.jobs.cancel(jid)
    H.finish(ctx, jid, 'cancelled')
    return handwrite.no_plan()
