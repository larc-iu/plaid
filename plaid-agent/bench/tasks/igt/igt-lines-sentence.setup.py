import common as c
import igtlib as L

DOC = 'Gitksan text 2'


def setup(ctx):
    """Sentence 14 left without analysis."""
    v = c.igt_values(L.raw(ctx, DOC))
    for w in [k for k in v if k.startswith('s14.') and k.count('.') == 1 and ':' not in k and '#' not in k]:
        L.strip_analysis(ctx, DOC, w)
    L.snap(ctx)
