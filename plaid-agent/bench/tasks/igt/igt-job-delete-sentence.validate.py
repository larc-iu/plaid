import handwrite
import igt_job_hand as H

DOC = 'Lezgi text 5'


def _job(ctx, calls, **report):
    jid = H.start(ctx, [DOC], 'Delete sentence 3.')
    if calls:
        did = next(d['id'] for d in ctx.project['documents'] if d['name'] == DOC)
        with ctx.client.operation('Assistant job: Delete sentence 3.', kind='job',
                                  ref=f'job:{jid}/doc:{did}/pass:gloss'):
            H.staged(ctx, ctx.client, calls, stamp_mode='machine',
                     detail={'model': 'm', 'version': 'v', 'job': jid})
    ctx.client.jobs.finish(jid, H.WORKER, 'done', {'state': 'done', **report})
    ctx.job = ctx.client.jobs.get(jid)
    return handwrite.no_plan()


def right(ctx):
    return _job(ctx, [('delete_sentence', {'document': DOC, 'refs': ['s3']})])


def wrong_only_proposed(ctx):
    """The deletion listed for a person, not made."""
    did = next(d['id'] for d in ctx.project['documents'] if d['name'] == DOC)
    return _job(ctx, [], proposed=[{'kind': 'delete_sentence', 'document_id': did, 'document': DOC, 'ref': 's3',
                                    'field': None, 'from': None, 'to': None, 'label': 'x', 'note': ''}])


def wrong_the_analysed_one(ctx):
    """Sentence 2 deleted: the text reads right, its analysis is lost."""
    return _job(ctx, [('delete_sentence', {'document': DOC, 'refs': ['s2']})])


def wrong_both(ctx):
    return _job(ctx, [('delete_sentence', {'document': DOC, 'refs': ['s2', 's3']})])


def wrong_words_only(ctx):
    """The copy's word tokens deleted, its text left: it still reads."""
    return _job(ctx, [('delete_word', {'document': DOC, 'refs': [f's3.w{i}' for i in range(1, 6)]})])


def wrong_another_sentence_too(ctx):
    return _job(ctx, [('delete_sentence', {'document': DOC, 'refs': ['s3']}),
                      ('set_field', {'document': DOC, 'refs': ['s4.w1.m1'], 'field': 'Gloss', 'value': 'X'})])
