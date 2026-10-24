import handwrite as h
import udplan

D = 'French 1'


def merge(ctx, deprel='parataxis'):
    udplan.apply(ctx, [('merge_sentences', {'document': D, 'ref': 's19', 'root_head': 's18.w23',
                                            'root_deprel': deprel})])


def punct(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's18.w38', 'head': 3, 'deprel': 'punct'}),
                       ('set_head', {'document': D, 'ref': 's18.w25', 'head': 27, 'deprel': 'punct'})])


def right(ctx):
    merge(ctx)
    punct(ctx)


def wrong_colon_left(ctx):
    merge(ctx)
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's18.w38', 'head': 3, 'deprel': 'punct'})])


def wrong_merge_only(ctx):
    merge(ctx)


def wrong_deprel(ctx):
    merge(ctx, deprel='conj')
    punct(ctx)


def wrong_old_numbering(ctx):
    # The semicolon addressed by its number before the merge (s19.w13 is now
    # a word of the next sentence).
    merge(ctx)
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's19.w13', 'head': 3, 'deprel': 'punct'})])


def wrong_nothing(ctx):
    return h.no_plan()
