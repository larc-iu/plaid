import handwrite as h
import umr_hand as u

NODES = [('s5k', 'kay', [(':refer-number', 'plural')], False),
         ('s5x', 'purara', [(':modal-strength', 'full-affirmative'), (':aspect', 'performance')], True),
         ('s5i', 'ikian', [], False),
         ('s5p', 'person', [(':refer-number', 'singular'), (':refer-person', '3rd')], False)]
EDGES = [('s5x', ':stimulus', 's5k'), ('s5k', ':mod', 's5i'), ('s5x', ':experiencer', 's5p')]


def right(ctx):
    # Other variable names than the old graph's, nodes made in another order,
    # attributes written in another order, and the :mod written as its
    # inverse: none of it matters.
    u.draft(ctx, 5, NODES, [('s5x', ':stimulus', 's5k'), ('s5i', ':mod-of', 's5k'),
                            ('s5x', ':experiencer', 's5p')])


def wrong_no_mod(ctx):
    u.draft(ctx, 5, NODES, EDGES[:1] + EDGES[2:])


def wrong_number_on_person(ctx):
    nodes = [n if n[0] != 's5p' else ('s5p', 'person', [(':refer-person', '3rd'), (':refer-number', 'plural')], False)
             for n in NODES]
    u.draft(ctx, 5, nodes, EDGES)


def wrong_extra_node(ctx):
    u.draft(ctx, 5, NODES + [('s5a', 'ay', [], False)], EDGES + [('s5x', ':temporal', 's5a')])


def wrong_root(ctx):
    nodes = [(v, c, a, v == 's5k') for v, c, a, _ in NODES]
    u.draft(ctx, 5, nodes, EDGES)


def wrong_collateral(ctx):
    u.draft(ctx, 5, NODES, EDGES)
    u.set_attr(ctx, 4, 's4k', ':refer-number', 'singular')


def wrong_nothing(ctx):
    return h.no_plan()
