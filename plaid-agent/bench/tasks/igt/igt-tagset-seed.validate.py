import re

import handwrite as h
import igt_tagsets as T


def _glosses(ctx):
    p = ctx.client.projects.get(ctx.project['id'])
    sl = T._morph_gloss(p)
    return sl, [v for v in T._values(ctx, sl['id']) if v]


def _tags(glosses):
    """Every grammatical part, split as the checker splits a gloss."""
    out = set()
    for v in glosses:
        for part in re.split(r'[.:\-=()]', v):
            part = part.strip()
            if part and not any(ch.islower() for ch in part) and any(ch.isalpha() for ch in part):
                out.add(part)
    return out


def _write(ctx, values, mode='mixed', assign=True):
    """The tagset as the page's own write leaves it (lib/panel.py runs it
    for an approved tagset plan): the project's setting, and the field's."""
    sl, _ = _glosses(ctx)
    ctx.client.projects.set_config(ctx.project['id'], 'igt', 'tagsets', {
        'Leipzig': {'mode': mode, 'delimiters': '.:', 'values': [{'value': x} for x in sorted(values)]}})
    if assign:
        ctx.client.span_layers.set_config(sl['id'], 'igt', 'tagset', 'Leipzig')


def right(ctx):
    _write(ctx, _tags(_glosses(ctx)[1]))


def wrong_closed(ctx):
    # Every tag, but closed where the user asked for mixed.
    _write(ctx, _tags(_glosses(ctx)[1]), mode='closed')


def wrong_composites_whole(ctx):
    # glm53-1: the glosses with no lowercase letter listed as they stand
    # (DEM2.DIST, RL.3AUG), so a part found only inside one is missing.
    _, glosses = _glosses(ctx)
    _write(ctx, {g for g in glosses if not any(ch.islower() for ch in g) and any(ch.isalpha() for ch in g)})


def wrong_word_glosses(ctx):
    # The tags and the ordinary word glosses too.
    _, glosses = _glosses(ctx)
    words = sorted({g for g in glosses if g.isalpha() and g.islower()})[:10]
    _write(ctx, _tags(glosses) | set(words))


def wrong_not_on_the_field(ctx):
    _write(ctx, _tags(_glosses(ctx)[1]), assign=False)


def wrong_collateral(ctx):
    # The right tagset, and a gloss of the data changed.
    right(ctx)
    h.set_span(ctx, 'Natugu text 1', 's1.w1.m1:Gloss', 'xyz')
