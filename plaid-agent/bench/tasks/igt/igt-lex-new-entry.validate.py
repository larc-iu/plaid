import handwrite as h
import igtlib as L


def right(ctx):
    L.create_entry(ctx, 'nyzlo', {'gloss': 'canoe', 'pos': 'n', 'morphType': 'stem'})


def wrong_missing_field(ctx):
    L.create_entry(ctx, 'nyzlo', {'gloss': 'canoe', 'pos': 'n'})


def wrong_as_sense(ctx):
    # A sense under an existing entry rather than a headword of its own.
    items = L.vocab_items(ctx.client, ctx.project['vocabs'][0]['id'])
    head = L.item_by_label(items, 'ma|house')
    L.create_entry(ctx, 'nyzlo', {'gloss': 'canoe', 'pos': 'n', 'morphType': 'stem', 'parent': head['id'],
                                  'senseOrder': 1})


def wrong_collateral(ctx):
    L.create_entry(ctx, 'nyzlo', {'gloss': 'canoe', 'pos': 'n', 'morphType': 'stem'})
    L.patch_entry(ctx, 'ma|house', {'pos': 'n'})


def wrong_nothing(ctx):
    return h.no_plan()
