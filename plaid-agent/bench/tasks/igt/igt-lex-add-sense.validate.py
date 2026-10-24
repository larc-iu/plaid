import handwrite as h
import igtlib as L


def _head(ctx):
    return L.item_by_label(L.vocab_items(ctx.client, ctx.project['vocabs'][0]['id']), 'wil|')['id']


def right(ctx):
    L.create_entry(ctx, 'wil', {'gloss': 'do', 'parent': _head(ctx), 'senseOrder': 3})


def wrong_headword(ctx):
    # A homograph headword rather than a sense.
    L.create_entry(ctx, 'wil', {'gloss': 'do'})


def wrong_relabel(ctx):
    # The LVB sense reglossed instead of a new sense.
    L.patch_entry(ctx, 'wil|LVB', {'gloss': 'do'})


def wrong_collateral(ctx):
    L.create_entry(ctx, 'wil', {'gloss': 'do', 'parent': _head(ctx), 'senseOrder': 3})
    L.patch_entry(ctx, 'wil|COMP', {'gloss': 'COMP, when'})


def wrong_nothing(ctx):
    return h.no_plan()
