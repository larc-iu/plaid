import igt_job_hand as H
import igtlib as L

DOC = 'Lezgi text 5'
FROM = 'Вичин хва хва рекьиз кӀан жени ?'


def setup(ctx):
    """Lezgi text 5's sentence 2 retyped by a person with хва twice: the
    copy is a new word, the first keeps its analysis."""
    H.staged(ctx, ctx.user, [('retype_sentence', {'document': DOC, 'ref': 's2', 'text': FROM})])
    d = L.raw(ctx, DOC)
    tl = d['text_layers'][0]
    body = tl['text']['body']
    texts = [body[t['begin']:t['end']].strip() for t in sorted(tl['token_layers'][0]['tokens'],
                                                              key=lambda t: t['begin'])]
    assert texts[1] == FROM, texts
    L.snap(ctx)
