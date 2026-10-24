import udplan

D = 'Arabic 1'


def setup(ctx):
    udplan.plant(ctx, [('set_words', {'document': D, 'ref': 's2.w27-28', 'forms': ['شقيقته']})])
    udplan.plant(ctx, [('set_field', {'document': D, 'refs': ['s2.w27'], 'field': 'upos', 'value': 'NOUN'}),
                       ('set_head', {'document': D, 'ref': 's2.w27', 'head': 24, 'deprel': 'nsubj'})])
