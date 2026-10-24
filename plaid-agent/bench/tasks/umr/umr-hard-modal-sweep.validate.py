import umr_hand as u

EVENTS = [(1, 's1x'), (1, 's1u'), (1, 's1c'), (2, 's2i2'), (2, 's2e'), (2, 's2x'), (3, 's3u'), (3, 's3c'),
          (4, 's4p'), (4, 's4u'), (5, 's5p'), (6, 's6r'), (7, 's7r'), (8, 's8u'), (8, 's8c'), (8, 's8a2'),
          (9, 's9y'), (9, 's9a'), (9, 's9c'), (10, 's10t'), (10, 's10p2'), (11, 's11y'), (11, 's11a2'),
          (12, 's12c'), (13, 's13p'), (14, 's14h'), (14, 's14p'), (15, 's15u'), (16, 's16h'),
          (17, 's17i2'), (17, 's17r'), (18, 's18h'), (19, 's19y')]
NEGATIVE = {(9, 's9y'), (13, 's13p'), (14, 's14p'), (17, 's17i2')}


def modal(s, var):
    return 'full-negative' if (s, var) in NEGATIVE else 'full-affirmative'


def right(ctx):
    for s, var in EVENTS:
        u.set_attr(ctx, s, var, ':modal-strength', modal(s, var))


def wrong_all_affirmative(ctx):
    for s, var in EVENTS:
        u.set_attr(ctx, s, var, ':modal-strength', 'full-affirmative')


def wrong_first_half(ctx):
    for s, var in EVENTS:
        if s <= 10:
            u.set_attr(ctx, s, var, ':modal-strength', modal(s, var))


def wrong_aspectless_too(ctx):
    # Concept-wide: the other aya (the shot in s9) and ichima get it too.
    right(ctx)
    u.set_attr(ctx, 9, 's9a3', ':modal-strength', 'full-affirmative')
    u.set_attr(ctx, 10, 's10i2', ':modal-strength', 'full-affirmative')


def wrong_one_negative_missed(ctx):
    for s, var in EVENTS:
        u.set_attr(ctx, s, var, ':modal-strength', 'full-affirmative' if (s, var) == (14, 's14p') else modal(s, var))
