import igtlib as L


def setup(ctx):
    L.create_entry(ctx, 'гада', {'gloss': 'boy, son'}, verified=False)
    L.link(ctx, 'Lezgi text 1', ['s4.w6.m1', 's9.w5.m1', 's10.w3.m1'], 'гада|boy', verified=False)
    L.link(ctx, 'Lezgi text 2', ['s10.w8.m1', 's13.w3.m1'], 'гада|boy, son', verified=False)
    L.snap(ctx)
