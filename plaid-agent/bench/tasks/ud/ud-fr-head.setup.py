import udplan


def setup(ctx):
    udplan.plant(ctx, [('set_head', {'document': 'French 3', 'ref': 's11.w13', 'head': 10, 'deprel': 'nmod'})])
