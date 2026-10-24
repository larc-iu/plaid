import handwrite as h
import udplan

D = 'French 1'


def split(ctx):
    udplan.apply(ctx, [('split_token', {'document': D, 'ref': 's5.w9'})])


def annotate(ctx, deprel='nmod'):
    udplan.apply(ctx, [
        ('set_field', {'document': D, 'refs': ['s5.w10'], 'field': 'lemma', 'value': 'artisan'}),
        ('set_field', {'document': D, 'refs': ['s5.w10'], 'field': 'upos', 'value': 'NOUN'}),
        ('set_field', {'document': D, 'refs': ['s5.w10'], 'field': 'features', 'value': 'Gender=Masc|Number=Sing'}),
        ('set_head', {'document': D, 'ref': 's5.w10', 'head': 9, 'deprel': deprel})])


def right(ctx):
    split(ctx)
    annotate(ctx)


def wrong_split_only(ctx):
    split(ctx)


def wrong_amod(ctx):
    split(ctx)
    annotate(ctx, deprel='amod')


def wrong_nothing(ctx):
    return h.no_plan()
