import udplan


def setup(ctx):
    udplan.plant(ctx, [('set_head', {'document': 'French 2', 'ref': 's7.w2', 'head': 0, 'deprel': 'root',
                                     'old_root_head': 2, 'old_root_deprel': 'xcomp'})])
