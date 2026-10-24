import umr_hand as u

# The 14 third person singular person nodes (him, the hunter). s16's
# variables are named s17* in the source.
HE = [(4, 's4p2'), (5, 's5p2'), (6, 's6p'), (7, 's7p'), (8, 's8p'), (9, 's9p'), (10, 's10p'), (11, 's11p'),
      (12, 's12p'), (13, 's13p2'), (15, 's15p'), (16, 's17p'), (18, 's18p'), (19, 's19p')]


def setup(ctx):
    a = u.as_admin(ctx)
    for s, var in HE:
        u.set_attr(a, s, var, ':refer-person', '3', verified=False)
