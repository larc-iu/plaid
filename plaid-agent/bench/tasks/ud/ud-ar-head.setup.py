import udplan


def setup(ctx):
    udplan.plant(ctx, [('set_head', {'document': 'Arabic 1', 'ref': 's1.w8', 'head': 6, 'deprel': 'obj'})])
