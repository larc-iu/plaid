import handwrite as h
import umr_hand as u


def right(ctx):
    u.set_concept(ctx, 15, 's15u', 'uwata')


def wrong_remade(ctx):
    # Deleted and made again: the right concept and roles, no alignment.
    d = u.Doc(ctx)
    ctx.user.tokens.bulk_delete(d.node(15, 's15u')['span']['tokens'])
    u.create_node(ctx, 15, 's15u', 'uwata', [(':aspect', 'process'), (':modal-strength', 'full-affirmative')],
                  root=True)
    for role, tgt in ((':actor', 's15p'), (':temporal', 's15a'), (':place', 's15x')):
        u.add_edge(ctx, 15, 's15u', role, tgt)


def wrong_concept(ctx):
    u.set_concept(ctx, 15, 's15u', 'walk-01')


def wrong_nothing(ctx):
    return h.no_plan()
