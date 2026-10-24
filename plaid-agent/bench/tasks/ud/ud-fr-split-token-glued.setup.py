import udglue


def setup(ctx):
    udglue.glue(ctx, 'French 1', 5, 9, keep_words=False)
