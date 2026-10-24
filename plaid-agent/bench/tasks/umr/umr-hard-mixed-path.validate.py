import umr_hand as u

GOOD = 'The way has no possessor in sentences 8 and 14. I added the scared man as possessor in 14.'


def applied(text):
    """An answer given with a plan that was then approved."""
    c = u.answer(text)
    c['display'][-1].update(status='applied', plan={'id': 'validation', 'proposed': [['validation']]})
    return c


def right(ctx):
    # :possessor, the second of the two roles the checker allows.
    u.add_edge(ctx, 14, 's14p2', ':possessor', 's14a')
    return applied(GOOD)


def wrong_answer_only(ctx):
    return u.answer(GOOD)


def wrong_bad_answer(ctx):
    u.add_edge(ctx, 14, 's14p2', ':poss', 's14a')
    return applied('Only sentence 8 has a way with no possessor.')


def wrong_both_fixed(ctx):
    u.add_edge(ctx, 14, 's14p2', ':poss', 's14a')
    u.add_edge(ctx, 8, 's8p2', ':poss', 's8p')
    return applied(GOOD)


def wrong_new_person(ctx):
    # A new node for the possessor instead of the man already there.
    u.create_node(ctx, 14, 's14p3', 'person', [(':refer-person', '3rd'), (':refer-number', 'singular')])
    u.add_edge(ctx, 14, 's14p2', ':poss', 's14p3')
    return applied(GOOD)


def wrong_guideline(ctx):
    """The right result plus a project guideline nobody asked for."""
    conv = right(ctx)
    import handwrite
    handwrite.add_guideline(ctx)
    return conv
