import handwrite
import igt_job_hand as H
import igtlib as L

DOC = 'Lezgi text 4'


def _ended(ctx, calls=(), **report):
    """A job over the text whose write is ``calls``, staged and applied as
    the job writes (machine, the job named)."""
    jid = H.start(ctx, [DOC], 'Correct the gloss DOG of я to COP.')
    if calls:
        did = L.doc_of(ctx, DOC)['id']
        with ctx.client.operation('Assistant job: Correct the gloss', kind='job',
                                  ref=f'job:{jid}/doc:{did}/pass:gloss'):
            H.staged(ctx, ctx.client, list(calls), stamp_mode='machine',
                     detail={'model': 'm', 'version': 'v', 'job': jid})
    ctx.client.jobs.finish(jid, H.WORKER, 'done', {'state': 'done', **report})
    ctx.job = ctx.client.jobs.get(jid)
    return handwrite.no_plan()


def _refs(ctx):
    """Every я of the text as the assistant's tools name it (sN.wN), the
    one glossed DOG first."""
    from plaid_agent.igt.project import load_document, load_project
    doc = load_document(ctx.client, load_project(ctx.client, ctx.project['id']), L.doc_of(ctx, DOC)['id'])
    words = [(s, w) for s in doc.sentences for w in s.words if w.surface.casefold() == 'я']
    words.sort(key=lambda x: not any(sp.value == 'DOG' for m in x[1].morphemes for sp in m.fields.values()))
    return [f's{s.index}.w{w.index}' for s, w in words]


def _first(ctx):
    return _refs(ctx)[0]


def right(ctx):
    return _ended(ctx, [('set_field', {'document': DOC, 'refs': [f'{_first(ctx)}.m1'], 'field': 'Gloss',
                                       'value': 'COP'})])


def right_by_a_new_analysis(ctx):
    return _ended(ctx, [('set_analysis', {'document': DOC, 'ref': _first(ctx),
                                          'morphemes': [{'form': 'я', 'fields': {'Gloss': 'COP'}}]})])


def wrong_only_proposed(ctx):
    did = L.doc_of(ctx, DOC)['id']
    return _ended(ctx, proposed=[{'kind': 'set_span', 'document_id': did, 'document': DOC,
                                  'ref': f'{_first(ctx)}.m1', 'field': 'Gloss', 'from': 'DOG', 'to': 'COP',
                                  'label': 'x', 'note': ''}])


def wrong_kept_verified(ctx):
    """COP written as the person's verified value: a job verifies nothing."""
    jid = H.start(ctx, [DOC], 'Correct the gloss DOG of я to COP.')
    first = [w for w, _ in H.words(ctx, DOC, form='я')][0]
    L.set_field(ctx, DOC, {f'{first}.m1': 'COP'}, verified=True)
    ctx.client.jobs.finish(jid, H.WORKER, 'done', {'state': 'done'})
    ctx.job = ctx.client.jobs.get(jid)
    return handwrite.no_plan()


def wrong_every_ya(ctx):
    """Every я glossed COP, the imported "was" too: not asked."""
    return _ended(ctx, [('set_field', {'document': DOC, 'refs': [f'{w}.m1' for w in _refs(ctx)],
                                       'field': 'Gloss', 'value': 'COP'})])
