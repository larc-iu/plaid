import handwrite as h
import igtlib as L


def _items(ctx):
    return L.vocab_items(ctx.client, ctx.project['vocabs'][0]['id'])


def right(ctx):
    it = _items(ctx)
    ctx.user.vocab_items.merge(L.item_by_label(it, 'гада|boy')['id'], [L.item_by_label(it, 'гада|boy, son')['id']])


def wrong_reversed(ctx):
    it = _items(ctx)
    ctx.user.vocab_items.merge(L.item_by_label(it, 'гада|boy, son')['id'], [L.item_by_label(it, 'гада|boy')['id']])


def wrong_deleted(ctx):
    # Deleting the duplicate takes its links with it.
    ctx.user.vocab_items.delete(L.item_by_label(_items(ctx), 'гада|boy, son')['id'])


def wrong_collateral(ctx):
    right(ctx)
    L.patch_entry(ctx, 'гада|boy', {'gloss': 'boy, son'})


def wrong_nothing(ctx):
    return h.no_plan()
