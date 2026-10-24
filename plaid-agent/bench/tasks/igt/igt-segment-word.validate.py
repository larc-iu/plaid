import handwrite as h
import igtlib as L

M = [('g̲al', 'contain'), ("ts'ep", 'village.people'), ("'y", '1SG.II')]


def right(ctx):
    # Analyzed, and the new morphemes linked to their entries (allowed).
    L.analyze(ctx, 'Gitksan text 1', 's12.w6', M)
    for i, lab in enumerate(['g̲al|contain', "ts'ep|village.people", "'y|1SG.II"], 1):
        L.link(ctx, 'Gitksan text 1', [f's12.w6.m{i}'], lab)


def wrong_bad_link(ctx):
    L.analyze(ctx, 'Gitksan text 1', 's12.w6', M)
    L.link(ctx, 'Gitksan text 1', ['s12.w6.m3'], "'nii'y|1SG.III")


def wrong_surface_form(ctx):
    L.analyze(ctx, 'Gitksan text 1', 's12.w6', [M[0], ("ts'eb", 'village.people'), M[2]])


def wrong_two_morphemes(ctx):
    L.analyze(ctx, 'Gitksan text 1', 's12.w6', [("g̲alts'ep", 'contain-village.people'), M[2]])


def wrong_collateral(ctx):
    L.analyze(ctx, 'Gitksan text 1', 's12.w6', M)
    L.set_field(ctx, 'Gitksan text 1', {'s12.w5.m1': 'eat.CAUS'})


def wrong_unglossed(ctx):
    L.analyze(ctx, 'Gitksan text 1', 's12.w6', [(f, None) for f, _ in M])


def wrong_nothing(ctx):
    return h.no_plan()
