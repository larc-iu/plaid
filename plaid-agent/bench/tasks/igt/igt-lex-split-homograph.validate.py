import handwrite as h
import igtlib as L


def right(ctx):
    # Freed, and the two homographs numbered (numbering them is no fault).
    L.patch_entry(ctx, 'mz|eye', {'parent': None, 'senseOrder': None, 'homograph': 2})
    L.patch_entry(ctx, 'mz|', {'homograph': 1})


def wrong_recreated(ctx):
    # A new headword made and the old sense deleted: a different entry.
    it = L.item_by_label(L.vocab_items(ctx.client, ctx.project['vocabs'][0]['id']), 'mz|eye')
    L.create_entry(ctx, 'mz', {'gloss': 'eye'})
    ctx.user.vocab_items.delete(it['id'])


def wrong_both_freed(ctx):
    L.patch_entry(ctx, 'mz|eye', {'parent': None, 'senseOrder': None})
    L.patch_entry(ctx, 'mz|PREP', {'parent': None, 'senseOrder': None})


def wrong_nothing(ctx):
    return h.no_plan()
