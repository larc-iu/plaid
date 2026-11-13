import handwrite
import igt_job_hand as H

DOC = 'Lezgi text 5'
TO = 'Вичин хва рекьиз кӀан жени ?'


def _job(ctx, calls, **report):
    jid = H.start(ctx, [DOC], 'Delete the second хва.')
    if calls:
        did = next(d['id'] for d in ctx.project['documents'] if d['name'] == DOC)
        with ctx.client.operation('Assistant job: Delete the second хва.', kind='job',
                                  ref=f'job:{jid}/doc:{did}/pass:gloss'):
            H.staged(ctx, ctx.client, calls, stamp_mode='machine',
                     detail={'model': 'm', 'version': 'v', 'job': jid})
    ctx.client.jobs.finish(jid, H.WORKER, 'done', {'state': 'done', **report})
    ctx.job = ctx.client.jobs.get(jid)
    return handwrite.no_plan()


def right(ctx):
    return _job(ctx, [('retype_sentence', {'document': DOC, 'ref': 's2', 'text': TO})])


def wrong_only_proposed(ctx):
    """The withdrawn rule's outcome: the deletion only proposed."""
    did = next(d['id'] for d in ctx.project['documents'] if d['name'] == DOC)
    return _job(ctx, [], proposed=[{'kind': 'edit_text', 'document_id': did, 'document': DOC, 'ref': 's2',
                                    'field': None, 'from': None, 'to': None, 'label': 'x', 'note': ''}])


def wrong_token_only(ctx):
    """The word's token deleted, its text left: the sentence still reads it."""
    return _job(ctx, [('delete_word', {'document': DOC, 'refs': ['s2.w3']})])


def wrong_another_sentence_too(ctx):
    return _job(ctx, [('retype_sentence', {'document': DOC, 'ref': 's2', 'text': TO}),
                      ('set_field', {'document': DOC, 'refs': ['s3.w1.m1'], 'field': 'Gloss', 'value': 'X'})])
