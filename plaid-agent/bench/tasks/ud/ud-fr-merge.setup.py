import udplan

D = 'French 1'


def setup(ctx):
    udplan.plant(ctx, [('split_sentence', {'document': D, 'ref': 's18.w26'})])
    udplan.plant(ctx, [('set_head', {'document': D, 'ref': 's19.w2', 'head': 0, 'deprel': 'root'}),
                       ('set_head', {'document': D, 'ref': 's19.w13', 'head': 2, 'deprel': 'punct'})])
