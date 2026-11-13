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
    _change(ctx)


def right_lexicon_too(ctx):
    # The texts right, and the lexicon's PREP sense renamed beside them: the
    # user says "Everywhere in the project", which may well take the lexicon
    # in (the owner's reading, REV-JG3, after glm53-stretch-3 reps 2 and 3).
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


def wrong_guideline_drafted_unasked(ctx):
    """The right result plus a guideline the user did not ask for, which is
    collateral since the owner's ruling of 2026-11-12."""
    conv = right(ctx)
    import handwrite
    handwrite.add_guideline(ctx, 'Gloss of mz', 'mz is glossed LOC, not PREP.')
    return conv
