import udplan


def setup(ctx):
    udplan.plant(ctx, [('merge_sentences', {'document': 'French 1', 'ref': 's3', 'root_head': 's2.w3',
                                            'root_deprel': 'parataxis'})])
