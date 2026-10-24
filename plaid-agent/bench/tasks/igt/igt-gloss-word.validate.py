import handwrite as h
import igtlib as L

G = {'s7.w15.m1': 'RL', 's7.w15.m2': 'go', 's7.w15.m3': 'COS', 's7.w15.m4': 'bz(PDIR.YON).o(1MINI)'}


def right(ctx):
    L.set_field(ctx, 'Natugu text 2', G)


def wrong_value(ctx):
    L.set_field(ctx, 'Natugu text 2', dict(G, **{'s7.w15.m4': 'PDIR.YON.1MINI'}))


def wrong_reanalyzed(ctx):
    # The word re-segmented rather than glossed.
    L.analyze(ctx, 'Natugu text 2', 's7.w15', [('tq', 'RL'), ('vz', 'go'), ('pe', 'COS'), ('bz', 'PDIR.YON'),
                                                 ('o', '1MINI')])


def wrong_collateral(ctx):
    L.set_field(ctx, 'Natugu text 2', dict(G, **{'s7.w16.m1': 'house.N'}))


def wrong_nothing(ctx):
    return h.no_plan()
