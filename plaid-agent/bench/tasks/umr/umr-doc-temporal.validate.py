import handwrite as h
import umr_hand as u


def right(ctx):
    u.add_triple(ctx, 'document-creation-time', ':before', 's6.s6r', 'temporal')
    u.add_triple(ctx, 's6.s6r', ':after', 's10.s10t', 'temporal')


def wrong_reversed(ctx):
    u.add_triple(ctx, 'document-creation-time', ':before', 's6.s6r', 'temporal')
    u.add_triple(ctx, 's6.s6r', ':before', 's10.s10t', 'temporal')


def wrong_dct_reversed(ctx):
    u.add_triple(ctx, 's6.s6r', ':before', 'document-creation-time', 'temporal')
    u.add_triple(ctx, 's10.s10t', ':before', 's6.s6r', 'temporal')


def wrong_half(ctx):
    u.add_triple(ctx, 'document-creation-time', ':before', 's6.s6r', 'temporal')


def wrong_extra(ctx):
    right(ctx)
    u.add_triple(ctx, 'document-creation-time', ':before', 's10.s10t', 'temporal')
