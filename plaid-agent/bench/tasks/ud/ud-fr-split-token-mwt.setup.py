import udglue


def setup(ctx):
    udglue.glue(ctx, 'French 1', 8, 5, keep_words=True)
