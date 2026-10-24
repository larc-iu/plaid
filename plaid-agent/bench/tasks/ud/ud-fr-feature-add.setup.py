import udplan


def setup(ctx):
    udplan.plant(ctx, [('set_feature', {'document': 'French 1', 'refs': ['s8.w8'], 'feature': 'Tense',
                                        'value': ''})])
