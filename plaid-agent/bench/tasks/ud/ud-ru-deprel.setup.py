import udplan


def setup(ctx):
    udplan.plant(ctx, [('set_head', {'document': 'Russian 2', 'ref': 's11.w5', 'head': 3, 'deprel': 'obj'})])
