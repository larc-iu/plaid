import handwrite as h
import umr_hand as u

NODES = [('s2a', 'and', [], True),
         ('s2i2', 'identity-91', [(':aspect', 'state'), (':modal-strength', 'full-affirmative')], False),
         ('s2i3', 'ikian', [(':refer-number', 'singular')], False),
         ('s2s', 'shiringuero', [(':refer-number', 'singular')], False),
         ('s2e', 'exist-91', [(':aspect', 'state'), (':modal-strength', 'full-affirmative')], False),
         ('s2s2', 'shiringa', [], False),
         ('s2x', 'ɨmɨntsarara', [(':aspect', 'performance'), (':modal-strength', 'full-affirmative')], False),
         ('s2p', 'person', [(':refer-person', '1st'), (':refer-number', 'singular')], False),
         ('s2t', 'tsuparan', [(':refer-number', 'singular')], False),
         ('s2i4', 'ikian', [], False),
         ('s2i5', 'ɨmɨna', [], False)]
EDGES = [('s2a', ':op1', 's2i2'), ('s2a', ':op2', 's2e'), ('s2a', ':op3', 's2x'), ('s2i2', ':ARG0', 's2i3'),
         ('s2i2', ':ARG1', 's2s'), ('s2e', ':ARG1', 's2s2'), ('s2x', ':actor', 's2p'), ('s2x', ':topic', 's2t'),
         ('s2t', ':mod', 's2i4'), ('s2e', ':temporal', 's2i5')]


def right(ctx):
    u.create_node(ctx, 2, 's2i5', 'ɨmɨna')
    u.add_edge(ctx, 2, 's2e', ':temporal', 's2i5')


def wrong_first_thing(ctx):
    u.create_node(ctx, 2, 's2i5', 'ɨmɨna')
    u.add_edge(ctx, 2, 's2i2', ':temporal', 's2i5')


def wrong_third_thing(ctx):
    u.create_node(ctx, 2, 's2i5', 'ɨmɨna')
    u.add_edge(ctx, 2, 's2x', ':temporal', 's2i5')


def wrong_remade(ctx):
    # The whole sentence drafted again: the graph is right, every alignment
    # is gone.
    u.delete_sentence_graph(ctx, 2)
    u.draft(ctx, 2, NODES, EDGES)


def wrong_collateral(ctx):
    right(ctx)
    u.set_attr(ctx, 3, 's3s', ':refer-number', 'plural')


def wrong_nothing(ctx):
    return h.no_plan()
