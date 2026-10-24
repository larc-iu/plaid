import umr_hand as u


def setup(ctx):
    u.delete_edge(u.as_admin(ctx), 14, 's14p', ':experiencer', 's14a')
