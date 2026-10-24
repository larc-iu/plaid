import common as c
import handwrite as h
import igtlib as L


def _change(ctx, skip_doc=None, also_eye=False):
    for d in ctx.project['documents']:
        if d['name'] == skip_doc:
            continue
        v = c.igt_values(L.raw(ctx, d['name']))
        refs = {k[:-5]: 'LOC' for k, x in v.items() if k.endswith(':form') and str(x).lower() == 'mz'
                and (v.get(k[:-5] + ':Gloss') == 'PREP' or also_eye)}
        L.set_field(ctx, d['name'], refs)


def right(ctx):
    # The lexicon's PREP sense renamed to match, which the task allows.
    _change(ctx)
    L.patch_entry(ctx, 'mz|PREP', {'gloss': 'LOC'})


def wrong_one_text(ctx):
    _change(ctx, skip_doc='Natugu text 5')


def wrong_eye_too(ctx):
    _change(ctx, also_eye=True)


def wrong_nothing(ctx):
    return h.no_plan()


def wrong_lexicon_only(ctx):
    L.patch_entry(ctx, 'mz|PREP', {'gloss': 'LOC'})


def right_with_guideline(ctx):
    """Not run by validate (only right and wrong_*): the right result plus
    the guideline the task allows."""
    conv = right(ctx)
    import handwrite
    handwrite.add_guideline(ctx, 'Gloss of mz', 'mz is glossed LOC, not PREP.')
    return conv
