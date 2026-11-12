import common as c
import igtlib as L

DOC = 'Gitksan text 2'


def setup(ctx):
    v = c.igt_values(L.raw(ctx, DOC))
    words = [k for k in v if ':' not in k and '#' not in k and k.count('.') == 1
             and int(k.split('.')[0][1:]) <= 5]
    for w in words:
        L.strip_analysis(ctx, DOC, w)
    L.snap(ctx)
