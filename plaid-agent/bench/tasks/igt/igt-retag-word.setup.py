import igtlib as L

POS = {'s3.w2': 'v', 's3.w3': 'pro', 's3.w4': 'pro', 's3.w5': 'post', 's3.w6': 'v', 's3.w7': 'v'}


def add_pos_field(ctx):
    """A word field POS, as the editor's field settings make one."""
    d = L.raw(ctx, 'Lezgi text 1')
    word_layer = L.layer_ids(d)['word']
    sl = ctx.client.span_layers.create(word_layer, 'POS')
    ctx.client.span_layers.set_config(sl['id'], 'igt', 'scope', 'Word')


def setup(ctx):
    add_pos_field(ctx)
    L.set_field(ctx, 'Lezgi text 1', POS, field='POS', verified=False)
    L.snap(ctx)
