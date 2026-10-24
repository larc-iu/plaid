import handwrite as h
import igtlib as L


def right(ctx):
    L.set_field(ctx, 'Lezgi text 1', {'s3.w2': 'conj'}, field='POS')
    L.set_field(ctx, 'Lezgi text 1', {'s3.w2.m1': 'but'})


def wrong_pos_only(ctx):
    L.set_field(ctx, 'Lezgi text 1', {'s3.w2': 'conj'}, field='POS')


def wrong_gloss_on_word(ctx):
    # The gloss written as a POS value, the morpheme left as it was.
    L.set_field(ctx, 'Lezgi text 1', {'s3.w2': 'conj'}, field='POS')
    L.set_field(ctx, 'Lezgi text 1', {'s3.w3': 'but'}, field='POS')


def wrong_collateral(ctx):
    right(ctx)
    L.set_field(ctx, 'Lezgi text 1', {'s3.w13.m1': 'but'})


def wrong_nothing(ctx):
    return h.no_plan()
