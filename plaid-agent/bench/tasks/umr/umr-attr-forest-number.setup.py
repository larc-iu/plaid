import umr_hand as u


def setup(ctx):
    a = u.as_admin(ctx)
    u.set_attr(a, 4, 's4x', ':refer-number', None, verified=False)
    u.set_attr(a, 15, 's15x', ':refer-number', None, verified=False)
