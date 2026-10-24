import handwrite as h


def right(ctx):
    h.set_span(ctx, 'French 1', 's2.w10:upos', 'CCONJ')


def wrong_word(ctx):
    h.set_span(ctx, 'French 1', 's2.w6:upos', 'CCONJ')


def wrong_collateral(ctx):
    h.set_span(ctx, 'French 1', 's2.w10:upos', 'CCONJ')
    h.set_span(ctx, 'French 1', 's2.w10:lemma', 'Donc')


def wrong_nothing(ctx):
    return h.no_plan()
