import udplan


def setup(ctx):
    udplan.plant(ctx, [('set_head', {'document': 'Russian 2', 'ref': 's1.w1', 'head': 0, 'deprel': 'root',
                                     'old_root_head': 1, 'old_root_deprel': 'amod'})])
