import udplan

D = 'Russian 2'


def setup(ctx):
    udplan.plant(ctx, [('merge_sentences', {'document': D, 'ref': 's11', 'root_head': 's10.w6',
                                            'root_deprel': 'parataxis'})])
    udplan.plant(ctx, [('merge_sentences', {'document': D, 'ref': 's5', 'root_head': 's4.w3',
                                            'root_deprel': 'parataxis'})])
