import igtlib as L


def setup(ctx):
    """An empty sentence field, as the editor's field settings make one."""
    d = L.raw(ctx, 'Lezgi text 1')
    sl = ctx.client.span_layers.create(L.layer_ids(d)['sentence'], 'Translation (ru)')
    ctx.client.span_layers.set_config(sl['id'], 'igt', 'scope', 'Sentence')
