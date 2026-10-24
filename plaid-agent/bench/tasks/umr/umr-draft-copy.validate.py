import handwrite as h
import umr_hand as u

NODES = [('s16h', 'have-mod-91', [(':aspect', 'state'), (':modal-strength', 'full-affirmative')], True),
         ('s16p', 'person', [(':refer-person', '3rd'), (':refer-number', 'singular')], False),
         ('s16x', 'ɨtsɨ', [], False),
         ('s16a', 'ay', [], False)]
EDGES = [('s16h', ':ARG1', 's16p'), ('s16h', ':ARG2', 's16x'), ('s16h', ':temporal', 's16a')]


def right(ctx):
    u.draft(ctx, 16, NODES, EDGES)


def wrong_intensifier_kept(ctx):
    nodes = [n if n[0] != 's16x' else ('s16x', 'ɨtsɨ', [(':degree', 'intensifier')], False) for n in NODES]
    u.draft(ctx, 16, nodes, EDGES)


def wrong_no_temporal(ctx):
    u.draft(ctx, 16, NODES[:3], EDGES[:2])


def wrong_copied_into_s18(ctx):
    # The intensifier taken off sentence 18 instead.
    u.draft(ctx, 16, NODES, EDGES)
    u.set_attrs(ctx, 18, 's18x', [])


def wrong_nothing(ctx):
    return h.no_plan()
