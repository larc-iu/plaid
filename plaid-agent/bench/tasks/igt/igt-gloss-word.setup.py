import igtlib as L


def setup(ctx):
    L.set_field(ctx, 'Natugu text 2', {f's7.w15.m{i}': None for i in range(1, 5)}, verified=False)
    L.snap(ctx)
