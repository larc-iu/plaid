import igtlib as L


def setup(ctx):
    """A word field Accessibility, as the editor's field settings make one,
    with no values."""
    d = L.raw(ctx, 'Lezgi text 1')
    sl = ctx.client.span_layers.create(L.layer_ids(d)['word'], 'Accessibility')
    ctx.client.span_layers.set_config(sl['id'], 'igt', 'scope', 'Word')
    L.snap(ctx)
