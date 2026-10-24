import umr_hand as u


def right(ctx):
    return u.answer('s9a2 is aligned to word 3, rchikari. The unaligned nodes are s9p (person), '
                    's9h (have-location-91) and s9t (thing).')


def wrong_missing_one(ctx):
    return u.answer('s9a2 is aligned to rchikari. The unaligned nodes are s9p and s9h.')


def wrong_word(ctx):
    return u.answer('s9a2 is aligned to ariwa. The unaligned nodes are s9p, s9h and s9t.')


def wrong_wrote(ctx):
    u.set_attr(ctx, 9, 's9a2', ':aspect', 'state')
    return u.answer('s9a2 is aligned to word 3, rchikari. The unaligned nodes are s9p, s9h and s9t.')
