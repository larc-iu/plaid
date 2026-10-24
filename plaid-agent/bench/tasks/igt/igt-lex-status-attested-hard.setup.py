"""Link every morpheme of Gitksan texts 1 and 3 to the entry or sense its
form and gloss name (101 lexicon items, links unstamped, as a person would
have made them), then give six items a status of their own: four of the
linked ones, which must keep theirs, and two unlinked ones, which must stay
as they are."""
import common as c
import igtlib as L

LINKED_DOCS = ['Gitksan text 1', 'Gitksan text 3']
PLANTED = {'hl|CN': 'reviewed', "bisde'y|grouse": 'published', 'dim|PROSP': 'reviewed',
           'wila|MANR': 'reviewed', 'gyet|people': 'reviewed', 'dulp|close': 'draft'}


def linked_labels(ctx):
    """The labels of the items the setup links, from the snapshot's values."""
    out = set()
    for name in LINKED_DOCS:
        v = c.igt_values(L.raw(ctx, name))
        for k, x in v.items():
            if k.endswith(':form'):
                out.add(f'{str(x).lower()}|{v.get(k[:-5] + ":Gloss") or ""}')
    return out


def setup(ctx):
    for name in LINKED_DOCS:
        v = c.igt_values(L.raw(ctx, name))
        by = {}
        for k, x in v.items():
            if k.endswith(':form'):
                by.setdefault(f'{str(x).lower()}|{v.get(k[:-5] + ":Gloss") or ""}', []).append(k[:-5])
        for lab, refs in by.items():
            L.link(ctx, name, refs, lab, verified=False)
    for lab, status in PLANTED.items():
        L.patch_entry(ctx, lab, {'status': status})
    L.snap(ctx)
