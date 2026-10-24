import udplan


def setup(ctx):
    udplan.plant(ctx, [('set_feature', {'document': 'Russian 2', 'refs': ['s7.w14'], 'feature': 'Case',
                                        'value': 'Nom'})])
