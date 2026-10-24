import udplan

# Four of the ten nsubj:pass made plain nsubj (word, head).
PLANTED = {'Russian 1': [('s20.w3', 1)], 'Russian 2': [('s4.w1', 3), ('s18.w1', 3)],
           'Russian 3': [('s3.w14', 12)]}
# The three the snapshot already has as plain nsubj under a passive participle.
NATURAL = {'Russian 1': [('s2.w1', 6), ('s9.w6', 8)], 'Russian 2': [('s17.w6', 8)]}


def setup(ctx):
    udplan.plant(ctx, [('set_head', {'document': d, 'ref': ref, 'head': head, 'deprel': 'nsubj'})
                       for d, words in PLANTED.items() for ref, head in words])
