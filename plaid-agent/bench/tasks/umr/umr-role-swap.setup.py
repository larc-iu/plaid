import umr_hand as u


def setup(ctx):
    a = u.as_admin(ctx)
    u.delete_edge(a, 12, 's12c', ':actor', 's12p')
    u.delete_edge(a, 12, 's12c', ':undergoer', 's12p2')
    u.add_edge(a, 12, 's12c', ':actor', 's12p2', verified=False)
    u.add_edge(a, 12, 's12c', ':undergoer', 's12p', verified=False)
