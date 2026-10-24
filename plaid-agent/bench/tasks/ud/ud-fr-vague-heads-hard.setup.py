import udplan


def setup(ctx):
    udplan.plant(ctx, [('set_head', {'document': 'French 1', 'ref': 's4.w20', 'head': 14, 'deprel': 'amod'}),
                       ('set_head', {'document': 'French 1', 'ref': 's20.w20', 'head': 12, 'deprel': 'advcl'})])
