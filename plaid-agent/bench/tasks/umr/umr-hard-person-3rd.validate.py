import umr_hand as u

HE = [(4, 's4p2'), (5, 's5p2'), (6, 's6p'), (7, 's7p'), (8, 's8p'), (9, 's9p'), (10, 's10p'), (11, 's11p'),
      (12, 's12p'), (13, 's13p2'), (15, 's15p'), (16, 's17p'), (18, 's18p'), (19, 's19p')]


def right(ctx):
    for s, var in HE:
        u.set_attr(ctx, s, var, ':refer-person', '3rd')


def wrong_overwrite_all_persons(ctx):
    # set_attribute_for_concept(person, overwrite) also turns the narrator
    # (1st) and the listener (2nd) into 3rd.
    right(ctx)
    for s, var in ((1, 's1p'), (1, 's1p2'), (2, 's2p')):
        u.set_attr(ctx, s, var, ':refer-person', '3rd')


def wrong_partial(ctx):
    for s, var in HE[:10]:
        u.set_attr(ctx, s, var, ':refer-person', '3rd')


def wrong_awa_too(ctx):
    # The man (awa) nodes get a :refer-person they never had.
    right(ctx)
    for s, var in ((1, 's1a'), (14, 's14a'), (17, 's17a')):
        u.set_attr(ctx, s, var, ':refer-person', '3rd')


def wrong_dropped_number(ctx):
    for s, var in HE:
        u.set_attrs(ctx, s, var, [(':refer-person', '3rd')])
