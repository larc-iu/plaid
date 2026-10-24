import handwrite as h
import umr_hand as u

SCARED = [(14, 's14h', 's14a2'), (16, 's16h', 's17a'), (18, 's18h', 's18a')]
OTHERS = [(15, 's15u', 's15a'), (17, 's17i2', 's17a2'), (19, 's19y', 's19a')]


def right(ctx):
    for s, src, tgt in SCARED:
        u.relabel_edge(ctx, s, src, ':temporal', tgt, ':mod')


def wrong_first_plan(ctx):
    # The turn 1 plan, approved as it was: all six.
    right(ctx)
    for s, src, tgt in OTHERS:
        u.relabel_edge(ctx, s, src, ':temporal', tgt, ':mod')


def wrong_unscared(ctx):
    for s, src, tgt in OTHERS:
        u.relabel_edge(ctx, s, src, ':temporal', tgt, ':mod')


def wrong_two_of_three(ctx):
    for s, src, tgt in SCARED[:2]:
        u.relabel_edge(ctx, s, src, ':temporal', tgt, ':mod')


def wrong_today_too(ctx):
    right(ctx)
    u.relabel_edge(ctx, 1, 's1x', ':temporal', 's1i3', ':mod')


def wrong_not_approved(ctx):
    return h.no_plan()


def right_narrowed_guideline(ctx):
    # The three right, and a guideline narrowed to them.
    right(ctx)
    h.add_guideline(ctx, 'ay "already" as modifier',
                    'The adverb ay ("already") attaches with :mod rather than :temporal when it modifies the scared '
                    'state, "he is already scared" and the like. Elsewhere it stays :temporal.')


def wrong_broad_guideline(ctx):
    # The narrowed edit with the first, story-wide convention recorded.
    right(ctx)
    h.add_guideline(ctx, 'ay "already"', 'The adverb ay ("already") attaches to its event with :mod, never :temporal.')
