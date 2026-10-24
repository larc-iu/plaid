import udplan


def setup(ctx):
    udplan.plant(ctx, [('set_head', {'document': 'Russian 2', 'ref': 's2.w16', 'head': 15, 'deprel': 'obj'})])
