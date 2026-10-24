import handwrite as h
import umr_hand as u

NODES = [('s19y', 'yapana', [(':aspect', 'activity'), (':modal-strength', 'full-affirmative')], True),
         ('s19p', 'person', [(':refer-person', '3rd'), (':refer-number', 'singular')], False),
         ('s19x', 'ɨwɨrati', [(':refer-number', 'singular')], False),
         ('s19a', 'ay', [], False)]
EDGES = [('s19y', ':actor', 's19p'), ('s19y', ':place', 's19x'), ('s19y', ':temporal', 's19a')]


def right(ctx):
    # Other names, another order, :mod for "already", no :modal-strength:
    # all allowed.
    nodes = [('s19r', 'yapana', [(':aspect', 'activity')], True),
             ('s19a', 'ay', [], False),
             ('s19f', 'ɨwɨrati', [], False),
             ('s19h', 'person', [(':refer-person', '3rd'), (':refer-number', 'singular')], False)]
    u.draft(ctx, 19, nodes, [('s19r', ':mod', 's19a'), ('s19r', ':actor', 's19h'), ('s19r', ':place', 's19f')])


def wrong_with_start(ctx):
    u.draft(ctx, 19, NODES + [('s19y2', 'yupuni', [], False)], EDGES + [('s19y2', ':mod', 's19y')])


def wrong_aspect(ctx):
    nodes = [n if n[0] != 's19y' else ('s19y', 'yapana', [(':aspect', 'process')], True) for n in NODES]
    u.draft(ctx, 19, nodes, EDGES)


def wrong_no_place(ctx):
    u.draft(ctx, 19, NODES, EDGES[:1] + EDGES[2:] + [('s19y', ':goal', 's19x')])


def wrong_collateral(ctx):
    u.draft(ctx, 19, NODES, EDGES)
    u.set_attr(ctx, 15, 's15u', ':aspect', 'activity')


def wrong_nothing(ctx):
    return h.no_plan()
