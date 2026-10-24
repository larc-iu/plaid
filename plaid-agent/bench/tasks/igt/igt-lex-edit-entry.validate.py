import handwrite as h
import igtlib as L


def right(ctx):
    L.patch_entry(ctx, 'руш|girl', {'gloss': 'girl, daughter', 'pos': 'n'})


def wrong_half(ctx):
    L.patch_entry(ctx, 'руш|girl', {'gloss': 'girl, daughter'})


def wrong_value(ctx):
    L.patch_entry(ctx, 'руш|girl', {'gloss': 'girl, daughter', 'pos': 'noun'})


def wrong_collateral(ctx):
    L.patch_entry(ctx, 'руш|girl', {'gloss': 'girl, daughter', 'pos': 'n'})
    L.patch_entry(ctx, 'гада|boy', {'pos': 'n'})


def wrong_nothing(ctx):
    return h.no_plan()
