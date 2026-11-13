import handwrite
import igt_job_hand as H


def _ended(ctx, documents, **report):
    jid = H.start(ctx, documents)
    ctx.client.jobs.finish(jid, H.WORKER, 'done', {'state': 'done', **report})
    ctx.job = ctx.client.jobs.get(jid)
    return jid
import igtlib as L

DOC = 'Lezgi text 4'


def _changes(ctx, to='COP'):
    """A proposed change at each я of the document, referenced as the job's
    parser numbers words (as the report holds them)."""
    from plaid_agent.igt.project import load_document, load_project
    did = L.doc_of(ctx, DOC)['id']
    doc = load_document(ctx.client, load_project(ctx.client, ctx.project['id']), did)
    refs = [f's{s.index}.w{w.index}' for s in doc.sentences for w in s.words if w.surface.casefold() == 'я']
    return [{'kind': 'set_span', 'document_id': did, 'document': DOC, 'ref': f'{r}.m1', 'field': 'Gloss',
             'from': 'was', 'to': to, 'label': 'x', 'note': ''} for r in refs]


def right(ctx):
    _ended(ctx, [DOC], proposed=_changes(ctx), proposed_more=0)
    return handwrite.no_plan()


def wrong_written(ctx):
    """The job wrote COP over the person's analysis as well as proposing it."""
    jid = _ended(ctx, [DOC], proposed=_changes(ctx), proposed_more=0)
    a = [w for w, _ in H.words(ctx, DOC, form='я')][-1]
    H.analyze(ctx, DOC, a, [('я', 'COP')], H.job_stamp(jid))
    return handwrite.no_plan()


def wrong_not_proposed(ctx):
    _ended(ctx, [DOC], proposed=[], proposed_more=0)
    return handwrite.no_plan()


def wrong_proposed_elsewhere(ctx):
    did = L.doc_of(ctx, DOC)['id']
    _ended(ctx, [DOC], proposed=[{'kind': 'set_span', 'document_id': did, 'document': DOC, 'ref': 's1.w1.m1',
                                  'field': 'Gloss', 'from': 'x', 'to': 'COP', 'label': 'x', 'note': ''}])
    return handwrite.no_plan()
