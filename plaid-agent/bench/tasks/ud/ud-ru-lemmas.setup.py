import udplan


def setup(ctx):
    udplan.plant(ctx, [('set_field', {'document': 'Russian 2', 'refs': [r], 'field': 'lemma', 'value': v})
                       for r, v in (('s18.w4', 'якобитами'), ('s18.w9', 'замке'), ('s18.w10', 'тюрьму'))])
