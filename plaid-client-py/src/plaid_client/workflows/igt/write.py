"""Write proposed analyses onto a document.

A plan is ``{'word': <derive word>, 'analysis': <analysis_for result>}``.
Per word, the proposal replaces the whole analysis: every stored morpheme
of the word is deleted, which takes its spans (every field, not only the
gloss) and its lexicon links with it, and every slot is created afresh
under an id minted here, with its gloss naming that id in the same batch.
Nothing of the old analysis carries over, so no link names an entry of a
form that is gone and no ``provConfirmed`` survives onto the model's work.
A word nobody has segmented has only its virtual morpheme, which is not
stored, so nothing is deleted for it. One atomic batch per chunk, and
chunks stay under the server's per-batch op cap.

Everything is stamped machine-made (``stamp_inferred``) with the recorded
prediction from the provenance convention: ``provDetail.form`` on each
morpheme (plus ``boundaries``, ``degraded`` and ``surfaceMismatch`` on the
first), ``provDetail.value`` on each gloss span. Callers are expected to
have applied the write contract already (:func:`select_targets`).
"""

from plaid_client.ids import uuid7
from plaid_client.provenance import stamp_inferred

BATCH_OP_BUDGET = 800  # the server caps one atomic batch at 1000 ops


def _stored(w):
    """The word's morphemes that exist as tokens (not its virtual one)."""
    return [m for m in w['morphs'] if not m.get('virtual')]


def _ops_for(p):
    n = len(p['analysis']['segments'])
    return len(_stored(p['word'])) + n + n


def chunk_plans(plans, budget=BATCH_OP_BUDGET):
    """Pack plans into chunks whose batch op count stays under
    ``budget`` (a chunk always holds at least one plan)."""
    chunks, cur, cur_ops = [], [], 0
    for p in plans:
        k = _ops_for(p)
        if cur and cur_ops + k > budget:
            chunks.append(cur)
            cur, cur_ops = [], 0
        cur.append(p)
        cur_ops += k
    if cur:
        chunks.append(cur)
    return chunks


def write_analyses(client, plans, gloss_layer_id, morph_layer_id, source, detail,
                   on_progress=None):
    """Write every plan; returns the number of words written. ``source`` is the
    producer id (``service_source(...)``), ``detail`` the provDetail base
    (model, language, ...) each stamp extends.

    ``on_progress(done, total)`` is called with the count of chunks written: a
    document of several thousand words is a dozen batches and a minute or more
    of writing, which used to pass without a word to the requester."""
    if not plans:
        return 0
    text_id = plans[0]['word']['text_id']
    written = 0
    chunks = chunk_plans(plans)
    for n, chunk in enumerate(chunks):
        if on_progress:
            on_progress(n, len(chunks))
        with client.batched() as b:
            for p in chunk:
                w, a = p['word'], p['analysis']
                for m in _stored(w):
                    b.tokens.delete(m['id'])  # cascades its spans + links
                for j, segment in enumerate(a['segments']):
                    form_detail = {**detail, 'form': segment}
                    if j == 0:
                        form_detail.update({
                            'boundaries': ''.join(a['joiners']),
                            **({'surfaceMismatch': True} if a['surface_mismatch'] else {}),
                            **({'degraded': True} if a['degraded'] else {})})
                    meta = {'form': segment, **stamp_inferred(source, detail=form_detail)}
                    if a['types'][j]:
                        meta['morphType'] = a['types'][j]
                    mid = uuid7()
                    b.tokens.create(morph_layer_id, text_id, w['token']['begin'], w['token']['end'],
                                    precedence=j + 1, metadata=meta, id=mid)
                    gloss = a['glosses'][j]
                    if gloss:
                        b.spans.create(gloss_layer_id, [mid], gloss,
                                       stamp_inferred(source, detail={**detail, 'value': gloss}))
        written += len(chunk)
    if on_progress:
        on_progress(len(chunks), len(chunks))
    return written
