import udplan


def setup(ctx):
    udplan.plant(ctx, [('set_feature', {'document': 'French 1', 'refs': ['s4.w35', 's4.w38', 's4.w41', 's4.w44'],
                                        'feature': 'Number', 'value': 'Sing'})])
