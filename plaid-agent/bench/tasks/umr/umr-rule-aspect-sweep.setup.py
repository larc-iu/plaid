import umr_hand as u

# Every node with :aspect performance in the snapshot (umr-rule-aspect-sweep.yaml).
PERFORMANCE = [(1, 's1x'), (1, 's1u'), (2, 's2x'), (3, 's3u'), (4, 's4p'), (5, 's5p'), (6, 's6r'), (7, 's7r'),
               (8, 's8a2'), (10, 's10t'), (10, 's10p2'), (11, 's11y'), (11, 's11a2'), (13, 's13p'), (17, 's17r')]


def setup(ctx):
    a = u.as_admin(ctx)
    for s, var in PERFORMANCE:
        u.set_attr(a, s, var, ':aspect', 'perform', verified=False)
