"""Write proposed analyses onto a document.

A plan is ``{'word': <derive word>, 'analysis': <analysis_for result>}``.
Per word: the existing default morpheme becomes the first slot (its form,
morphType and provenance patched), further slots are created, every
morpheme in the chosen gloss field gets a span, and any morpheme or gloss
the proposal replaces is deleted first. Two atomic batches per chunk,
because created morphemes' ids are needed before their glosses can be
written; chunks stay under the server's per-batch op cap.

Everything is stamped machine-made (``stamp_inferred``) with the recorded
prediction from the provenance convention: ``provDetail.form`` on each
morpheme (plus ``boundaries``, ``degraded`` and ``surfaceMismatch`` on the
first), ``provDetail.value`` on each gloss span. Callers are expected to
have applied the write contract already (:func:`select_targets`).
"""

from plaid_client.provenance import stamp_inferred

BATCH_OP_BUDGET = 800  # the server caps one atomic batch at 1000 ops


def _ops_for(p):
    a = p['analysis']
    n = len(a['segments'])
    w = p['word']
    return (len(w['morphs']) - 1) + len(w['morph_spans'].get(w['morphs'][0]['id'], [])) \
        + 1 + (n - 1) + n


def chunk_plans(plans, budget=BATCH_OP_BUDGET):
    """Pack plans into chunks whose worst-case batch-1 op count stays under
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


def write_analyses(client, plans, gloss_layer_id, morph_layer_id, source, detail):
    """Write every plan; returns the number of words written. ``source`` is the
    producer id (``service_source(...)``), ``detail`` the provDetail base
    (model, language, ...) each stamp extends."""
    if not plans:
        return 0
    text_id = plans[0]['word']['token']['text']
    written = 0
    for chunk in chunk_plans(plans):
        # batch 1: clear replaced material, patch the first morpheme, create
        # the rest, gloss the first morpheme.
        created = []  # (op index, gloss)
        idx = 0
        with client.batched() as b:
            for p in chunk:
                w, a = p['word'], p['analysis']
                m0 = w['morphs'][0]
                base = stamp_inferred(source, detail=detail)
                for m in w['morphs'][1:]:
                    client.tokens.delete(m['id'])  # cascades its spans + links
                    idx += 1
                for sl_id, sp in w['morph_spans'].get(m0['id'], []):
                    if sl_id == gloss_layer_id:
                        client.spans.delete(sp['id'])
                        idx += 1
                m0_stamp = dict(base)
                m0_stamp['provDetail'] = {**detail, 'form': a['segments'][0],
                                          'boundaries': ''.join(a['joiners']),
                                          **({'surfaceMismatch': True} if a['surface_mismatch'] else {}),
                                          **({'degraded': True} if a['degraded'] else {})}
                client.tokens.patch_metadata(m0['id'], {
                    'form': a['segments'][0], 'morphType': a['types'][0], **m0_stamp})
                idx += 1
                for j in range(1, len(a['segments'])):
                    meta = {'form': a['segments'][j],
                            **stamp_inferred(source, detail={**detail, 'form': a['segments'][j]})}
                    if a['types'][j]:
                        meta['morphType'] = a['types'][j]
                    client.tokens.create(morph_layer_id, text_id,
                                         w['token']['begin'], w['token']['end'],
                                         precedence=j + 1, metadata=meta)
                    created.append((idx, a['glosses'][j]))
                    idx += 1
                if a['glosses'][0]:
                    client.spans.create(gloss_layer_id, [m0['id']], a['glosses'][0],
                                        stamp_inferred(source, detail={**detail, 'value': a['glosses'][0]}))
                    idx += 1
        results = b.results
        # batch 2: glosses for the created morphemes (ids known now).
        todo = []
        for op_idx, gloss in created:
            if not gloss:
                continue
            r = results[op_idx] if op_idx < len(results) else None
            mid = (r or {}).get('body', {}).get('id') if isinstance(r, dict) else None
            if mid:
                todo.append((mid, gloss))
        if todo:
            with client.batched():
                for mid, gloss in todo:
                    client.spans.create(gloss_layer_id, [mid], gloss,
                                        stamp_inferred(source, detail={**detail, 'value': gloss}))
        written += len(chunk)
    return written
