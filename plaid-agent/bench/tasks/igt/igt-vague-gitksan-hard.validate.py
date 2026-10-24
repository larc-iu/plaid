import handwrite as h
import igtlib as L

D = 'Gitksan text 1'


def right(ctx):
    L.set_field(ctx, D, {'s14.w7.m1': 'run.away.PL', 's18.w1.m1': 'WH'})


def wrong_every_huut(ctx):
    # The moose running away in text 2 changed as well.
    right(ctx)
    L.set_field(ctx, 'Gitksan text 2', {'s18.w9.m1': 'run.away.PL'})


def wrong_wrong_what(ctx):
    # The "what" of "we asked what he did" (s17) instead of the question itself.
    L.set_field(ctx, D, {'s14.w7.m1': 'run.away.PL', 's17.w4.m1': 'WH'})


def wrong_both_whats(ctx):
    right(ctx)
    L.set_field(ctx, D, {'s17.w4.m1': 'WH'})


def wrong_half(ctx):
    L.set_field(ctx, D, {'s14.w7.m1': 'run.away.PL'})


def wrong_nothing(ctx):
    return h.no_plan()
