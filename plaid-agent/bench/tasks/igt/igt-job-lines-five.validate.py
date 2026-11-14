import common as c
import handwrite
import igt_job_hand as H
import igtlib as L

DOC = 'Gitksan text 2'
SENTENCES = range(16, 21)


def _gold(ctx):
    """{sentence: [(word address, [(form, gloss), ...]), ...]} from the
    snapshot's own analysis of sentences 16 to 20."""
    doc = L.doc_of(ctx, DOC)
    v = c.igt_values(c.baseline(doc['id']))
    out = {}
    for a, _ in H.words(ctx, DOC, sentences=SENTENCES):
        ms, i = [], 1
        while f'{a}.m{i}:form' in v:
            ms.append((v[f'{a}.m{i}:form'], v.get(f'{a}.m{i}:Gloss')))
            i += 1
        out.setdefault(int(a.split('.')[0][1:]), []).append((a, ms))
    return out


def _lines(words):
    return {'forms': ' '.join('-'.join(f for f, _ in ms) for _, ms in words),
            'gloss': ' '.join('-'.join(g or '_' for _, g in ms) for _, ms in words)}


def _items(words):
    """One "FORMS GLOSS" item per word, as the tool takes them."""
    return ['-'.join(f for f, _ in ms) + ' ' + '-'.join(g or '_' for _, g in ms) for _, ms in words]


def _ended(ctx, calls=()):
    jid = H.start(ctx, [DOC])
    if calls:
        did = L.doc_of(ctx, DOC)['id']
        with ctx.client.operation('Assistant job: analyses', kind='job', ref=f'job:{jid}/doc:{did}/pass:gloss'):
            H.staged(ctx, ctx.client, list(calls), stamp_mode='machine',
                     detail={'model': 'm', 'version': 'v', 'job': jid})
    H.finish(ctx, jid)
    return handwrite.no_plan()


def right(ctx):
    # One analyze_sentence call over the five sentences, as a piece makes it.
    gold = _gold(ctx)
    return _ended(ctx, [('analyze_sentence', {'document': DOC, 'new_entries': True, 'sentences': [
        {'ref': f's{s}', 'words': _items(words)} for s, words in sorted(gold.items())]})])


def right_by_hand(ctx):
    jid = H.start(ctx, [DOC])
    for words in _gold(ctx).values():
        for a, ms in words:
            H.gloss(ctx, jid, DOC, a, ms)
    H.finish(ctx, jid)
    return handwrite.no_plan()


def wrong_run4_refused(ctx):
    """Run4's piece: each sentence's morphemes on its first word. The tool
    refuses every sentence and stages nothing, so the job writes nothing."""
    gold = _gold(ctx)
    run4 = [{'ref': f's{s}', 'words': [_lines(words)['forms'].replace(' ', '-') + ' '
                                       + _lines(words)['gloss'].replace(' ', '-')]}
            for s, words in sorted(gold.items())]
    said, ops = H.tool_answer(ctx, ctx.user, 'analyze_sentence',
                              {'document': DOC, 'new_entries': True, 'sentences': run4})
    assert said.startswith('Error: s16 not staged: words has 1 item, s16 has 11 words') and not ops, said
    return _ended(ctx)


def wrong_run4_written(ctx):
    """Run4's piece had it been written: the first word of each sentence
    holds the sentence, the other words are left."""
    jid = H.start(ctx, [DOC])
    for words in _gold(ctx).values():
        H.gloss(ctx, jid, DOC, words[0][0], [m for _, ms in words for m in ms])
    H.finish(ctx, jid)
    return handwrite.no_plan()


def wrong_left_one(ctx):
    jid = H.start(ctx, [DOC])
    for words in _gold(ctx).values():
        for a, ms in words:
            if a != 's18.w5':
                H.gloss(ctx, jid, DOC, a, ms)
    H.finish(ctx, jid)
    return handwrite.no_plan()
