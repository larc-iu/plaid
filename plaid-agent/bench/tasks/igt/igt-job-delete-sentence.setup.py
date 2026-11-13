import igt_job_hand as H
import igtlib as L

DOC = 'Lezgi text 5'
TEXT = 'Вичин хва рекьиз кӀан жени ?'


def setup(ctx):
    """Lezgi text 5's sentence 2 typed again by a person on a line of its
    own: sentence 3, a copy whose words have no analysis. Sentence 2 keeps
    its own."""
    H.staged(ctx, ctx.user, [('retype_sentence', {'document': DOC, 'ref': 's2', 'text': TEXT + '\n' + TEXT})])
    d = L.raw(ctx, DOC)
    tl = d['text_layers'][0]
    body = tl['text']['body']
    texts = [body[t['begin']:t['end']].strip() for t in sorted(tl['token_layers'][0]['tokens'],
                                                              key=lambda t: t['begin'])]
    assert texts[1] == texts[2] == TEXT, texts
    L.snap(ctx)
