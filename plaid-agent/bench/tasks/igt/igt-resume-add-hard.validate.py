import common as c
import handwrite as h
import igtlib as L


def _change(ctx, renames):
    for d in ctx.project['documents']:
        v = c.igt_values(L.raw(ctx, d['name']))
        refs = {k[:-6]: renames[x] for k, x in v.items() if k.endswith(':Gloss') and x in renames}
        L.set_field(ctx, d['name'], refs)


def right(ctx):
    _change(ctx, {'INESS': 'INE', 'SPSS': 'SRESS'})


def wrong_turn_two_only(ctx):
    # The incident: turn 2 staged only its own change, which replaced the
    # waiting card, so the approval wrote the superessive alone.
    _change(ctx, {'SPSS': 'SRESS'})


def wrong_turn_one_only(ctx):
    _change(ctx, {'INESS': 'INE'})


def wrong_poess_too(ctx):
    # Both renames, and the postessive "tidied" the same way, which nobody asked.
    _change(ctx, {'INESS': 'INE', 'SPSS': 'SRESS', 'POESS': 'POE'})


def wrong_nothing(ctx):
    return h.no_plan()
