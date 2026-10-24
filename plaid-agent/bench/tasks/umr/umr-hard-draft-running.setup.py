import umr_hand as u


def setup(ctx):
    u.delete_sentence_graph(u.as_admin(ctx), 19)
