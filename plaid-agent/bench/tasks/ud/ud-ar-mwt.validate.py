import handwrite as h
import udplan

D = 'Arabic 1'


def split(ctx):
    udplan.apply(ctx, [('set_words', {'document': D, 'ref': 's2.w27', 'forms': ['شقيقة', 'ه']})])


def annotate(ctx, pron_lemma='هُوَ', xpos=False):
    calls = [
        ('set_field', {'document': D, 'refs': ['s2.w27'], 'field': 'lemma', 'value': 'شَقِيقَة'}),
        ('set_field', {'document': D, 'refs': ['s2.w27'], 'field': 'upos', 'value': 'NOUN'}),
        ('set_field', {'document': D, 'refs': ['s2.w27'], 'field': 'features',
                       'value': 'Case=Nom|Definite=Cons|Number=Sing'}),
        ('set_head', {'document': D, 'ref': 's2.w27', 'head': 24, 'deprel': 'nsubj'}),
        ('set_field', {'document': D, 'refs': ['s2.w28'], 'field': 'lemma', 'value': pron_lemma}),
        ('set_field', {'document': D, 'refs': ['s2.w28'], 'field': 'upos', 'value': 'PRON'}),
        ('set_field', {'document': D, 'refs': ['s2.w28'], 'field': 'features',
                       'value': 'Case=Gen|Gender=Masc|Number=Sing|Person=3|PronType=Prs'}),
        ('set_head', {'document': D, 'ref': 's2.w28', 'head': 27, 'deprel': 'nmod'})]
    if xpos:
        calls += [('set_field', {'document': D, 'refs': ['s2.w27'], 'field': 'xpos', 'value': 'N------S1R'}),
                  ('set_field', {'document': D, 'refs': ['s2.w28'], 'field': 'xpos', 'value': 'SP---3MS2-'})]
    udplan.apply(ctx, calls)


def right(ctx):
    split(ctx)
    annotate(ctx)


def wrong_split_only(ctx):
    split(ctx)


def wrong_lemma_undiacritized(ctx):
    split(ctx)
    annotate(ctx, pron_lemma='هو')


def wrong_nothing(ctx):
    return h.no_plan()
