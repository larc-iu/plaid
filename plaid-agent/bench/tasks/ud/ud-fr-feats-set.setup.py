import udplan


def setup(ctx):
    udplan.plant(ctx, [('set_field', {'document': 'French 1', 'refs': ['s2.w2'], 'field': 'features',
                                      'value': 'Gender=Masc|Number=Sing'})])
