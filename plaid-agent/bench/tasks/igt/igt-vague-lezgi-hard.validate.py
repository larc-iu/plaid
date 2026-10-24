import handwrite as h
import igtlib as L

# Addresses as the checker numbers them (punctuation counted).
RIGHT = {'s10.w3.m1': 'son', 's10.w15.m2': 'FUT', 's10.w17.m2': 'AOC'}


def right(ctx):
    L.set_field(ctx, 'Lezgi text 3', RIGHT)


def wrong_twin_too(ctx):
    # The identical sentence in text 2 fixed as well.
    right(ctx)
    L.set_field(ctx, 'Lezgi text 2', {'s13.w3.m1': 'son', 's13.w15.m2': 'FUT', 's13.w17.m2': 'AOC'})


def wrong_twin_only(ctx):
    L.set_field(ctx, 'Lezgi text 2', {'s13.w3.m1': 'son', 's13.w15.m2': 'FUT', 's13.w17.m2': 'AOC'})


def wrong_first_said(ctx):
    L.set_field(ctx, 'Lezgi text 3', {'s10.w3.m1': 'son', 's10.w15.m2': 'FUT', 's10.w4.m2': 'AOC'})


def wrong_every_said(ctx):
    right(ctx)
    L.set_field(ctx, 'Lezgi text 3', {'s10.w4.m2': 'AOC', 's10.w10.m2': 'AOC'})


def wrong_nothing(ctx):
    return h.no_plan()
