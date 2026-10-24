import handwrite as h
import igtlib as L


def right(ctx):
    L.create_entry(ctx, "'nii win", {'gloss': 'and then', 'morphType': 'phrase'})
    L.link_phrase(ctx, 'Gitksan text 1', ['s9.w2', 's9.w3'], "'nii win|and then")


def wrong_single_links(ctx):
    # Each word linked on its own rather than as one expression.
    L.create_entry(ctx, "'nii win", {'gloss': 'and then', 'morphType': 'phrase'})
    L.link(ctx, 'Gitksan text 1', ['s9.w2', 's9.w3'], "'nii win|and then")


def wrong_entry_only(ctx):
    L.create_entry(ctx, "'nii win", {'gloss': 'and then', 'morphType': 'phrase'})


def wrong_collateral(ctx):
    right(ctx)
    L.create_entry(ctx, "'nii win", {'gloss': 'then'})


def wrong_nothing(ctx):
    return h.no_plan()
