import umr_hand as u


def setup(ctx):
    a = u.as_admin(ctx)
    for s, var in ((4, 's4p'), (5, 's5p'), (13, 's13p')):
        u.set_attr(a, s, var, ':aspect', 'state', verified=False)
