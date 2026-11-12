import handwrite as h
import umr_hand as u

PERFORMANCE = [(1, 's1x'), (1, 's1u'), (2, 's2x'), (3, 's3u'), (4, 's4p'), (5, 's5p'), (6, 's6r'), (7, 's7r'),
               (8, 's8a2'), (10, 's10t'), (10, 's10p2'), (11, 's11y'), (11, 's11a2'), (13, 's13p'), (17, 's17r')]


def right(ctx):
    for s, var in PERFORMANCE:
        u.set_attr(ctx, s, var, ':aspect', 'performance')


def wrong_first_stretch(ctx):
    # The over-reach of bench glm53-stretch-2: sentences 1 to 5 only, the
    # rest offered for a later turn.
    for s, var in PERFORMANCE:
        if s <= 5:
            u.set_attr(ctx, s, var, ':aspect', 'performance')


def wrong_ten_sentences(ctx):
    for s, var in PERFORMANCE:
        if s <= 10:
            u.set_attr(ctx, s, var, ':aspect', 'performance')


def wrong_concept_wide(ctx):
    # set_attribute_for_concept(purara, overwrite) also makes the state in
    # sentence 14 a performance.
    right(ctx)
    u.set_attr(ctx, 14, 's14p', ':aspect', 'performance')


def wrong_pe_without_aspect(ctx):
    # The way (pe) nodes with no aspect get one.
    right(ctx)
    for s, var in ((8, 's8p2'), (9, 's9p2'), (12, 's12p2')):
        u.set_attr(ctx, s, var, ':aspect', 'performance')


def wrong_dropped_modal(ctx):
    # The whole attribute set replaced, :modal-strength lost.
    for s, var in PERFORMANCE:
        u.set_attrs(ctx, s, var, [(':aspect', 'performance')])


def wrong_nothing(ctx):
    return h.no_plan()
