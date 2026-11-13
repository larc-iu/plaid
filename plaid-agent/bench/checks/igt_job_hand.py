"""Hand-made results of a job (bench validate): a job started by the task's
user and claimed by admin A, words written as the job writes them (machine,
the job named in provDetail) or otherwise, and the job finished."""
import re

import common as c
import igtlib as L

WORKER = '0193a5c0-0000-7000-8000-000000000001'
SOURCE = 'service:igt:job:openai-glm-5.3-flash'


def job_stamp(job_id):
    return {'prov': 'inferred', 'provSource': SOURCE, 'provDetail': {'model': 'm', 'version': 'v', 'job': job_id}}


def start(ctx, documents, instructions='Segment and gloss every word nobody has analyzed.'):
    ids = [L.doc_of(ctx, n)['id'] for n in documents]
    made = ctx.user.jobs.create(ctx.project['id'], 'igt', instructions, ids)
    claimed = ctx.client.jobs.claim(WORKER, 'openai/m', ['igt'])
    assert claimed['job']['id'] == made['id']
    return made['id']


def finish(ctx, job_id, state='done'):
    ctx.client.jobs.finish(job_id, WORKER, state, {'state': state},
                           reason='cancelled' if state == 'cancelled' else None)
    ctx.job = ctx.client.jobs.get(job_id)


def analyze(ctx, document, word_addr, morphs, meta):
    """``igtlib.analyze`` with the stamp ``meta`` on every piece."""
    d = L.raw(ctx, document)
    ids, lay = L.ids_by_address(d), L.layer_ids(d)
    tl = d['text_layers'][0]
    wtok = next(t for t in c._layer(tl, 'word')['tokens'] if t['id'] == ids[word_addr])
    L.strip_analysis(ctx, document, word_addr)
    for i, (form, gloss) in enumerate(morphs, 1):
        t = ctx.user.tokens.create(lay['morpheme'], lay['text'], wtok['begin'], wtok['end'], precedence=i,
                                   metadata={'form': form, **meta})
        tid = t['id'] if isinstance(t, dict) else t
        if gloss is not None:
            ctx.user.spans.create(lay['Gloss'], [tid], gloss, meta or None)


def words(ctx, document, sentences=None, form=None):
    """The word addresses of ``document``, in order: of the sentences
    numbered in ``sentences``, or spelled ``form``."""
    d = L.raw(ctx, document)
    tl = d['text_layers'][0]
    body = tl['text']['body']
    addr = L.addresses(d)
    out = []
    for t in c._sorted(c._layer(tl, 'word')['tokens']):
        a = addr.get(t['id'])
        if not a:
            continue
        s = int(re.match(r's(\d+)', a).group(1))
        surface = body[t['begin']:t['end']]
        if (sentences is None or s in sentences) and (form is None or surface.casefold() == form.casefold()):
            out.append((a, surface))
    return out


def gloss(ctx, job_id, document, word_addr, morphs):
    """A word analysed as the job's stretch writes it: stamped as the job's,
    in a History entry of the job's glossing pass."""
    did = L.doc_of(ctx, document)['id']
    with ctx.user.operation('Assistant job: analyses', kind='job', ref=f'job:{job_id}/doc:{did}/pass:gloss'):
        analyze(ctx, document, word_addr, morphs, job_stamp(job_id))
