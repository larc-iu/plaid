import common as c
import igtlib as L

DOC = 'Gitksan text 2'


def setup(ctx):
    """Sentence 14 left without analysis, and the entries for gipaykw fly and bisde'y grouse deleted."""
    v = c.igt_values(L.raw(ctx, DOC))
    for w in [k for k in v if k.startswith('s14.') and k.count('.') == 1 and ':' not in k and '#' not in k]:
        L.strip_analysis(ctx, DOC, w)
    items = L.vocab_items(ctx.client, ctx.project['vocabs'][0]['id'])
    for lab in ('gipaykw|fly', "bisde'y|grouse"):
        ctx.user.vocab_items.delete(L.item_by_label(items, lab)['id'])
    L.snap(ctx)
