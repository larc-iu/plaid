import udplan


def setup(ctx):
    udplan.plant(ctx, [('set_field', {'document': 'Arabic 1', 'refs': ['s1.w7'], 'field': 'features',
                                      'value': 'Case=Nom|Definite=Ind|Number=Sing'})])
