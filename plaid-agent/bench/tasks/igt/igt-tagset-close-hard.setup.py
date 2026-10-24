import igtlib as L


def setup(ctx):
    """A mixed Leipzig list on the morpheme gloss field, holding every tag the
    field uses, so closing it would refuse every word gloss."""
    import re
    import igt_tagsets as T
    p = ctx.client.projects.get(ctx.project['id'])
    sl = T._morph_gloss(p)
    tags = set()
    for v in T._values(ctx, sl['id']):
        for part in re.split(r'[.:\-=()]', v):
            part = part.strip()
            if part and not any(ch.islower() for ch in part) and any(ch.isalpha() for ch in part):
                tags.add(part)
    ctx.client.projects.set_config(ctx.project['id'], 'igt', 'tagsets', {
        'Leipzig': {'mode': 'mixed', 'delimiters': '.:', 'values': [{'value': x} for x in sorted(tags)]}})
    ctx.client.span_layers.set_config(sl['id'], 'igt', 'tagset', 'Leipzig')
    L.snap(ctx)
    T.snap(ctx)
