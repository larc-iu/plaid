import udplan

BYT = {'Russian 1': ['s9.w23', 's17.w30', 's19.w73'],
       'Russian 2': ['s4.w2', 's7.w2', 's8.w6', 's12.w1', 's12.w12', 's18.w2'],
       'Russian 3': ['s3.w11', 's15.w4']}


def setup(ctx):
    udplan.plant(ctx, [('set_field', {'document': d, 'refs': refs, 'field': 'upos', 'value': 'VERB'})
                       for d, refs in BYT.items()])
