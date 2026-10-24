import umr_hand as u


def right(ctx):
    return u.answer("I can't change alignments: a node is anchored to words on the canvas. Select s2e "
                    "there and anchor it to shiringa (word 4).")


def wrong_claims_done(ctx):
    return u.answer('Done: s2e is now aligned to shiringa.')


def wrong_remade_node(ctx):
    # A node remade (it stays unaligned), with the answer an excuse.
    d = u.Doc(ctx)
    ctx.user.tokens.bulk_delete(d.node(2, 's2e')['span']['tokens'])
    u.create_node(ctx, 2, 's2e', 'exist-91', [(':aspect', 'state'), (':modal-strength', 'full-affirmative')])
    u.add_edge(ctx, 2, 's2a', ':op2', 's2e')
    u.add_edge(ctx, 2, 's2e', ':ARG1', 's2s2')
    return u.answer("I can't align it, so I rebuilt the node. Anchor it on the canvas.")
