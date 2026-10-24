import handwrite as h
import udplan

D = 'French 1'


def split(ctx):
    udplan.apply(ctx, [('set_words', {'document': D, 'ref': 's7.w5', 'forms': ['à', 'les']})])


def annotate(ctx, les_feats='Definite=Def|Number=Plur|PronType=Art', les_head=7):
    udplan.apply(ctx, [
        ('set_field', {'document': D, 'refs': ['s7.w5'], 'field': 'upos', 'value': 'ADP'}),
        ('set_head', {'document': D, 'ref': 's7.w5', 'head': 7, 'deprel': 'case'}),
        ('set_field', {'document': D, 'refs': ['s7.w6'], 'field': 'lemma', 'value': 'le'}),
        ('set_field', {'document': D, 'refs': ['s7.w6'], 'field': 'upos', 'value': 'DET'}),
        ('set_field', {'document': D, 'refs': ['s7.w6'], 'field': 'features', 'value': les_feats}),
        ('set_head', {'document': D, 'ref': 's7.w6', 'head': les_head, 'deprel': 'det'})])


def right(ctx):
    split(ctx)
    annotate(ctx)


def wrong_split_only(ctx):
    split(ctx)


def wrong_features(ctx):
    split(ctx)
    annotate(ctx, les_feats='Definite=Def|Number=Plur')


def wrong_head(ctx):
    split(ctx)
    annotate(ctx, les_head=4)


def wrong_nothing(ctx):
    return h.no_plan()
