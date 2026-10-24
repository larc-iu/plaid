import udplan

D = 'French 1'


def setup(ctx):
    udplan.plant(ctx, [('set_words', {'document': D, 'ref': 's7.w5-6', 'forms': ['aux']})])
    udplan.plant(ctx, [('set_field', {'document': D, 'refs': ['s7.w5'], 'field': 'upos', 'value': 'ADP'}),
                       ('set_head', {'document': D, 'ref': 's7.w5', 'head': 6, 'deprel': 'case'})])
