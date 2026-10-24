import common as c
import igtlib as L


def setup(ctx):
    L.strip_analysis(ctx, 'Gitksan text 1', 's4.w9')
    d = L.raw(ctx, 'Gitksan text 1')
    w = L.ids_by_address(d)['s4.w9']
    tok = next(t for t in c._layer(d['text_layers'][0], 'word')['tokens'] if t['id'] == w)
    ctx.user.tokens.split(w, tok['begin'] + len('silin'))
    L.snap(ctx)
