import handwrite as h
import umr_hand as u

NODES = [('s13p', 'purara', [(':aspect', 'performance'), (':modal-strength', 'full-negative')], True),
         ('s13p2', 'person', [(':refer-person', '3rd'), (':refer-number', 'singular')], False),
         ('s13p3', 'pe', [(':refer-number', 'singular')], False)]
EDGES = [('s13p', ':experiencer', 's13p2'), ('s13p', ':stimulus', 's13p3'), ('s13p3', ':possessor', 's13p2')]


def right(ctx):
    u.draft(ctx, 13, NODES, EDGES)


def wrong_second_person(ctx):
    # The possessor is a new person node rather than the experiencer.
    u.draft(ctx, 13, NODES + [('s13p4', 'person', [(':refer-person', '3rd'), (':refer-number', 'singular')], False)],
            EDGES[:2] + [('s13p3', ':possessor', 's13p4')])


def wrong_polarity(ctx):
    # Negation as :polarity - with modal-strength left affirmative.
    nodes = [NODES[0][:2] + ([(':aspect', 'performance'), (':modal-strength', 'full-affirmative'),
                              (':polarity', '-')], True)] + NODES[1:]
    u.draft(ctx, 13, nodes, EDGES)


def wrong_no_possessor(ctx):
    u.draft(ctx, 13, NODES, EDGES[:2])


def wrong_nothing(ctx):
    return h.no_plan()
