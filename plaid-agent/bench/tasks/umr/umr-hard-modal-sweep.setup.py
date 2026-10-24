import umr_hand as u

# Every node with an :aspect (the events). All of them have :modal-strength
# in the snapshot, full-negative on the four NEGATIVE ones.
EVENTS = [(1, 's1x'), (1, 's1u'), (1, 's1c'), (2, 's2i2'), (2, 's2e'), (2, 's2x'), (3, 's3u'), (3, 's3c'),
          (4, 's4p'), (4, 's4u'), (5, 's5p'), (6, 's6r'), (7, 's7r'), (8, 's8u'), (8, 's8c'), (8, 's8a2'),
          (9, 's9y'), (9, 's9a'), (9, 's9c'), (10, 's10t'), (10, 's10p2'), (11, 's11y'), (11, 's11a2'),
          (12, 's12c'), (13, 's13p'), (14, 's14h'), (14, 's14p'), (15, 's15u'), (16, 's16h'),
          (17, 's17i2'), (17, 's17r'), (18, 's18h'), (19, 's19y')]
NEGATIVE = {(9, 's9y'), (13, 's13p'), (14, 's14p'), (17, 's17i2')}


def setup(ctx):
    a = u.as_admin(ctx)
    for s, var in EVENTS:
        u.set_attr(a, s, var, ':modal-strength', None, verified=False)
