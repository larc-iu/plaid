import handwrite as h
import umr_hand as u


def right(ctx):
    u.add_edge(ctx, 14, 's14p', ':experiencer', 's14a')


def wrong_new_node(ctx):
    u.create_node(ctx, 14, 's14a3', 'awa')
    u.add_edge(ctx, 14, 's14p', ':experiencer', 's14a3')


def wrong_role(ctx):
    u.add_edge(ctx, 14, 's14p', ':actor', 's14a')


def wrong_moved(ctx):
    # The person moved under purara, and gone from have-mod-91.
    u.delete_edge(ctx, 14, 's14h', ':ARG1', 's14a')
    u.add_edge(ctx, 14, 's14p', ':experiencer', 's14a')
