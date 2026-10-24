import umr_hand as u


def right(ctx):
    # The numbers written as references, as glm-5.2 wrote them.
    return u.answer('Four sentences: **s9** (s9y), **s13** (s13p), s14 (s14p) and s17 (s17i2).')


def wrong_missing(ctx):
    return u.answer('Sentences 9, 13 and 17.')


def wrong_neighbour(ctx):
    # 19 and 113 are not 9 and 13.
    return u.answer('Sentences 19, 113, 14 and 17.')


def wrong_wrote(ctx):
    u.set_attr(ctx, 13, 's13p', ':polarity', '-')
    return u.answer('Sentences 9, 13, 14 and 17.')
