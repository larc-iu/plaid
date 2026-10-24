import handwrite as h
import igtlib as L

EYE = [('Natugu text 2', 's7.w7.m1'), ('Natugu text 3', 's6.w2.m1'), ('Natugu text 4', 's13.w9.m1')]


def right(ctx):
    for d, r in EYE:
        L.unlink(ctx, d, [r])


def wrong_relinked(ctx):
    # Linked to the eye sense: not what was asked.
    for d, r in EYE:
        L.unlink(ctx, d, [r])
        L.link(ctx, d, [r], 'mz|eye')


def wrong_two_of_three(ctx):
    for d, r in EYE[:2]:
        L.unlink(ctx, d, [r])


def wrong_collateral(ctx):
    right(ctx)
    L.unlink(ctx, 'Natugu text 2', ['s1.w9.m1'])


def wrong_nothing(ctx):
    return h.no_plan()
