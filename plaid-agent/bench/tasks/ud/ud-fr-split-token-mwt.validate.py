import handwrite as h
import udplan

D = 'French 1'


def right(ctx):
    udplan.apply(ctx, [('split_token', {'document': D, 'ref': 's8.w5-6'})])


def wrong_one_word(ctx):
    # set_words with one form: one token again, its two words replaced by one.
    udplan.apply(ctx, [('set_words', {'document': D, 'ref': 's8.w5-6', 'forms': ['bas coût']})])


def wrong_nothing(ctx):
    return h.no_plan()
